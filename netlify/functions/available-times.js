const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const { service_id, date, staff_id } = JSON.parse(event.body);

    if (!service_id || !date) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing service_id or date' }) };
    }

    // Get service duration
    const { data: service } = await supabase
      .from('services')
      .select('duration_minutes')
      .eq('id', service_id)
      .single();

    if (!service) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Service not found' }) };
    }

    // Parse date as local time (YYYY-MM-DD format from mobile/desktop date input)
    // This ensures consistent day_of_week calculation across all devices
    const [year, month, day] = date.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day); // Local time, not UTC
    const dayOfWeek = selectedDate.getDay() === 0 ? 6 : selectedDate.getDay() - 1;

    // Get staff availability
    let query = supabase
      .from('availability')
      .select('staff_id, start_time, end_time')
      .eq('day_of_week', dayOfWeek);

    if (staff_id) {
      query = query.eq('staff_id', staff_id);
    }

    const { data: availableSlots } = await query;

    if (!availableSlots || availableSlots.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ available_slots: [] }) };
    }

    // Get booked appointments for this date (using local time range)
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0).toISOString();
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59).toISOString();

    const { data: booked } = await supabase
      .from('appointments')
      .select('appointment_time')
      .gte('appointment_time', startOfDay)
      .lte('appointment_time', endOfDay)
      .eq('status', 'booked');

    // Generate time slots
    const slots = [];
    for (let hour = 9; hour < 19; hour++) {
      for (let min = 0; min < 60; min += 30) {
        const slotTime = new Date(year, month - 1, day, hour, min, 0);

        const isBooked = booked?.some(apt => {
          const aptTime = new Date(apt.appointment_time);
          const aptEnd = new Date(aptTime.getTime() + service.duration_minutes * 60000);
          return slotTime >= aptTime && slotTime < aptEnd;
        });

        if (!isBooked) {
          slots.push({
            time: slotTime.toISOString(),
            time_display: slotTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
          });
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ available_slots: slots }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};
