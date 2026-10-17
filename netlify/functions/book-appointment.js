const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const { customer_name, customer_email, customer_phone, service_id, date, time, staff_id, notes } = JSON.parse(event.body);

    if (!customer_name || !customer_email || !customer_phone || !service_id || !date || !time) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Get service details
    const { data: service } = await supabase
      .from('services')
      .select('name, price')
      .eq('id', service_id)
      .single();

    if (!service) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Service not found' }) };
    }

    // Create appointment
    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert([{
        customer_name,
        customer_email,
        customer_phone,
        service_id,
        staff_id: staff_id || null,
        appointment_time: time,
        status: 'booked',
        notes
      }])
      .select();

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not create appointment' }) };
    }

    const appointmentDate = new Date(time);
    const timeStr = appointmentDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const dateStr = appointmentDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    // Send confirmation email (but don't fail if email fails)
    try {
      await sgMail.send({
        to: customer_email,
        from: 'contact@royalnailbar.com',
        subject: 'Appointment Confirmed - Royal Nail Bar',
        html: `<h2>Your appointment is confirmed! 💅</h2>
          <p>Hi ${customer_name},</p>
          <p><strong>${service.name}</strong></p>
          <p><strong>${dateStr} at ${timeStr}</strong></p>
          <p><strong>Price:</strong> $${service.price}</p>
          <p>Location: The Shoppes at East Shore, 2411 Ocoee Apopka Rd, Apopka, FL 32703</p>
          <p>Please arrive 5-10 minutes early.</p>`
      });
    } catch (emailError) {
      console.error('Email send failed:', emailError);
      // Still return success since appointment was created
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Appointment confirmed!' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};
