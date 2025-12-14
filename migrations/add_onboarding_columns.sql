-- Add onboarding tracking columns to users table
ALTER TABLE users 
ADD COLUMN onboarding_completed BOOLEAN DEFAULT false NOT NULL,
ADD COLUMN onboarding_completed_at TIMESTAMP;

-- Create index for faster queries
CREATE INDEX idx_users_onboarding_completed ON users(onboarding_completed);
