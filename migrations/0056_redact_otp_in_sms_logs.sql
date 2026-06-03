-- One-time scrub: redact OTP codes already sitting in sms_logs in plaintext.
--
-- Going forward, lib/sms-service.ts redacts code-bearing bodies before logging
-- (logSafeSmsBody). This cleans up the history written before that change so no
-- live-or-expired 6-digit code remains readable in the table.

UPDATE sms_logs
SET message = '[OTP code redacted]'
WHERE message_type = 'phone_otp'
   OR message ~* 'Your code is\s*[0-9]{4,8}';
