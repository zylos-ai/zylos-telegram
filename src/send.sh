#!/bin/bash
# zylos-telegram send interface
# Usage: send.sh <chat_id> "<message>"
# Supports: text, [MEDIA:image], [MEDIA:file]
# Returns: 0 success, non-zero failure

set -e

CHAT_ID="$1"
MESSAGE="$2"

if [ -z "$CHAT_ID" ] || [ -z "$MESSAGE" ]; then
    echo "Usage: send.sh <chat_id> \"<message>\""
    exit 1
fi

# Load environment
ENV_FILE="$HOME/zylos/.env"
if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "Error: TELEGRAM_BOT_TOKEN not set"
    exit 1
fi

# Proxy setup
CURL_OPTS=""
if [ -n "$TELEGRAM_PROXY_URL" ]; then
    CURL_OPTS="--proxy $TELEGRAM_PROXY_URL"
fi

API_BASE="https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN"
MAX_LENGTH=4000

# Check for media prefix
if [[ "$MESSAGE" == "[MEDIA:image]"* ]]; then
    # Extract file path
    FILE_PATH="${MESSAGE#\[MEDIA:image\]}"

    if [ ! -f "$FILE_PATH" ]; then
        echo "Error: File not found: $FILE_PATH"
        exit 1
    fi

    # Send photo
    curl -s $CURL_OPTS -X POST "$API_BASE/sendPhoto" \
        -F "chat_id=$CHAT_ID" \
        -F "photo=@$FILE_PATH" > /dev/null

    echo "Sent photo to $CHAT_ID"
    exit 0
fi

if [[ "$MESSAGE" == "[MEDIA:file]"* ]]; then
    # Extract file path
    FILE_PATH="${MESSAGE#\[MEDIA:file\]}"

    if [ ! -f "$FILE_PATH" ]; then
        echo "Error: File not found: $FILE_PATH"
        exit 1
    fi

    # Send document
    curl -s $CURL_OPTS -X POST "$API_BASE/sendDocument" \
        -F "chat_id=$CHAT_ID" \
        -F "document=@$FILE_PATH" > /dev/null

    echo "Sent file to $CHAT_ID"
    exit 0
fi

# Send text message
send_text() {
    local text="$1"
    local json_payload

    json_payload=$(jq -n --arg text "$text" --arg chat_id "$CHAT_ID" \
        '{chat_id: $chat_id, text: $text}')

    curl -s $CURL_OPTS -X POST "$API_BASE/sendMessage" \
        -H "Content-Type: application/json" \
        -d "$json_payload" > /dev/null
}

# If message is short, send directly
if [ ${#MESSAGE} -le $MAX_LENGTH ]; then
    send_text "$MESSAGE"
    echo "Sent: ${MESSAGE:0:50}..."
    exit 0
fi

# Split long messages by paragraphs
echo "Splitting message (${#MESSAGE} chars)..."
chunk=""
chunk_num=0

while IFS= read -r line || [ -n "$line" ]; do
    if [ -z "$chunk" ]; then
        chunk="$line"
    elif [ $((${#chunk} + ${#line} + 2)) -le $MAX_LENGTH ]; then
        chunk="$chunk
$line"
    else
        # Send current chunk
        send_text "$chunk"
        chunk_num=$((chunk_num + 1))
        echo "Sent chunk $chunk_num"
        sleep 0.3
        chunk="$line"
    fi
done <<< "$MESSAGE"

# Send remaining
if [ -n "$chunk" ]; then
    send_text "$chunk"
    chunk_num=$((chunk_num + 1))
    echo "Sent chunk $chunk_num"
fi

echo "Done! Sent $chunk_num chunks."
