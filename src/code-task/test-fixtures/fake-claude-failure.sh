#!/bin/bash
# Fake claude CLI that crashes with an error
echo "Error: something went wrong" >&2
cat << 'EOF'
{"type":"result","subtype":"error","is_error":true,"duration_ms":500,"num_turns":1,"result":"Fatal error: unable to read CLAUDE.md","stop_reason":"error","session_id":"test-session-fail-789","total_cost_usd":0.03,"usage":{}}
EOF
exit 1
