#!/bin/bash
# Fake claude CLI that writes a successful JSON result to stdout
cat << 'EOF'
{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":5,"result":"Done — implemented the feature.\n\nStatus: DONE\nFiles changed: 3","stop_reason":"end_turn","session_id":"test-session-abc-123","total_cost_usd":0.42,"usage":{}}
EOF
exit 0
