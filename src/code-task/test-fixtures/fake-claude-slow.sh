#!/bin/bash
# Fake claude CLI that takes a while (for concurrency/orphan tests)
sleep 30
cat << 'EOF'
{"type":"result","subtype":"success","is_error":false,"duration_ms":30000,"num_turns":1,"result":"Done","session_id":"test-session-slow","total_cost_usd":0.01,"usage":{}}
EOF
exit 0
