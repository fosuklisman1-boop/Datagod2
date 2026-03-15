
import { sendSMS, SMSTemplates } from './lib/sms-service';

async function testSMS() {
  console.log('Testing SMS notification system...');
  console.log('SMS_ENABLED:', process.env.SMS_ENABLED);
  console.log('SMS_PROVIDER:', process.env.SMS_PROVIDER);
  
  if (!process.env.TEST_PHONE) {
    console.error('TEST_PHONE environment variable is missing.');
    return;
  }

  try {
    const result = await sendSMS({
      phone: process.env.TEST_PHONE,
      message: 'DATAGOD: Diagnostic SMS test. If you received this, SMS is working.',
      type: 'diagnostic_test'
    });
    console.log('Result:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Simple check if we can reach the exported templates
console.log('Template check:', typeof SMSTemplates.userSuspended === 'function' ? 'OK' : 'FAIL');

// We can't really run this easily without a full env, but we can check the file structure
