-- Add sub_agent_profit_margin column to sub_agent_catalog
-- This stores the sub-agent's own profit (selling_price - parent_price)
ALTER TABLE sub_agent_catalog
ADD COLUMN sub_agent_profit_margin NUMERIC(10,2) DEFAULT 0;

-- Optional: Add comment to clarify the column purpose
COMMENT ON COLUMN sub_agent_catalog.sub_agent_profit_margin IS 'Sub-agent profit margin: selling_price - parent_price. This is separate from the parent margin.';
