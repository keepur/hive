#!/bin/bash
# Fake claude CLI that exits with an escalation (NEEDS_CONTEXT)
cat << 'EOF'
{"type":"result","subtype":"success","is_error":false,"duration_ms":5000,"num_turns":12,"result":"Status: NEEDS_CONTEXT\nQuestion: The plan references a ProjectController but there are two versions — v1 at src/modules/project/api/v1/ and v2 at src/modules/project/api/v2/. Which one should I modify?\nContext: Both controllers handle project state transitions. v1 is deprecated but still used by 3 callers.","stop_reason":"end_turn","session_id":"test-session-escalation-456","total_cost_usd":1.05,"usage":{}}
EOF
exit 0
