const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { email, first_name } = JSON.parse(event.body);

    if (!email || !email.includes('@')) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    const { data, error } = await supabase
      .from('subscribers')
      .insert([{ email, first_name, source: 'website' }])
      .select();

    if (error) {
      if (error.code === '23505') {
        return { statusCode: 409, body: JSON.stringify({ error: 'Email already subscribed' }) };
      }
      throw error;
    }

    await sgMail.send({
      to: email,
      from: 'welcome@royalnailbar.com',
      subject: 'Welcome to Royal Nail Bar - 30% Off!',
      html: `<h2>Welcome!</h2>
        <p>Hi ${first_name || 'there'},</p>
        <p>Your 30% off code: <strong>ROYAL30</strong></p>
        <p>Royal Nail Bar - The Shoppes at East Shore, 2411 Ocoee Apopka Rd, Apopka, FL 32703</p>`
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Welcome!' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};
