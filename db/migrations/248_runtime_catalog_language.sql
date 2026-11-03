-- Keep the default execution profile provider-neutral in the control plane.
-- LiteLLM can still be connected as an ordinary OpenAI-compatible provider,
-- but it is not the identity of Argus' in-process runtime.

UPDATE mcp_agent_runtime_profiles
   SET label = 'Argus API runtime',
       description = 'In-process Argus execution using the model alias and provider configured on the Agent.'
 WHERE name = 'argus-default'
   AND runtime_type = 'argus';
