-- Retire the former Spark preview model from the default Codex subscription
-- profile. The current Codex CLI rejects gpt-5.3-codex-spark for ChatGPT
-- accounts, while gpt-5.6-terra is supported by the same protected login.

UPDATE mcp_agent_runtime_profiles
   SET label = 'Codex Terra · ChatGPT Subscription',
       model = 'gpt-5.6-terra',
       reasoning_effort = 'xhigh',
       description = 'Official Codex SDK runtime using the local ChatGPT login in the codex-auth volume. Uses GPT-5.6 Terra for governed implementation, investigation and review tasks.'
 WHERE name = 'codex-subscription-local'
   AND runtime_type = 'codex'
   AND auth_mode = 'chatgpt';
