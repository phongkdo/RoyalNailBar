const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async () => {
  try {
    const now = new Date();
    const in23Hours = new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString();
    const in25Hours = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

    const { data: appointments } = await supabase
      .from('appointments')
      .select('id, customer_name, customer_email, service_id, appointment_time')
      .eq('status', 'booked')
      .gte('appointment_time', in23Hours)
      .lte('appointment_time', in25Hours);

    if (!appointments || appointments.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No reminders to send' }) };
    }

    let sentCount = 0;
    for (const apt of appointments) {
      try {
        const { data: service } = await supabase
          .from('services')
          .select('name')
          .eq('id', apt.service_id)
          .single();

        const appointmentDate = new Date(apt.appointment_time);
        const timeStr = appointmentDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const dateStr = appointmentDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

        await sgMail.send({
          to: apt.customer_email,
          from: 'reminders@royalnailbar.com',
          subject: 'Reminder: Your appointment tomorrow at Royal Nail Bar',
          html: `<h2>See you tomorrow! 💅</h2>
            <p>Hi ${apt.customer_name},</p>
            <p><strong>${service.name}</strong></p>
            <p><strong>${dateStr} at ${timeStr}</strong></p>
            <p>Location: The Shoppes at East Shore, 2411 Ocoee Apopka Rd, Apopka, FL 32703</p>
            <p>Please arrive 5-10 minutes early.</p>`
        });
        sentCount++;
      } catch (emailError) {
        console.error('Error sending reminder:', emailError);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ sent: sentCount, total: appointments.length }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};
