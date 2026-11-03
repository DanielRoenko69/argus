-- Persist the bounded customer-facing branding contract used by the public
-- widget loader. Operator-only controls remain outside this configuration.

ALTER TABLE mcp_public_widgets
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS input_placeholder TEXT,
  ADD COLUMN IF NOT EXISTS launcher_icon_url TEXT,
  ADD COLUMN IF NOT EXISTS launcher_icon_alt TEXT,
  ADD COLUMN IF NOT EXISTS launcher_position VARCHAR(5) NOT NULL DEFAULT 'right';

ALTER TABLE mcp_public_widgets
  DROP CONSTRAINT IF EXISTS mcp_public_widgets_title_length,
  ADD CONSTRAINT mcp_public_widgets_title_length CHECK (title IS NULL OR char_length(title) <= 80),
  DROP CONSTRAINT IF EXISTS mcp_public_widgets_placeholder_length,
  ADD CONSTRAINT mcp_public_widgets_placeholder_length CHECK (input_placeholder IS NULL OR char_length(input_placeholder) <= 160),
  DROP CONSTRAINT IF EXISTS mcp_public_widgets_icon_url_length,
  ADD CONSTRAINT mcp_public_widgets_icon_url_length CHECK (launcher_icon_url IS NULL OR char_length(launcher_icon_url) <= 2048),
  DROP CONSTRAINT IF EXISTS mcp_public_widgets_icon_alt_length,
  ADD CONSTRAINT mcp_public_widgets_icon_alt_length CHECK (launcher_icon_alt IS NULL OR char_length(launcher_icon_alt) <= 120),
  DROP CONSTRAINT IF EXISTS mcp_public_widgets_launcher_position_check,
  ADD CONSTRAINT mcp_public_widgets_launcher_position_check CHECK (launcher_position IN ('left', 'right'));
