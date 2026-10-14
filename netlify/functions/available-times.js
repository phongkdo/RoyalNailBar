const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const TIME_ZONE = 'America/New_York';

// Durations for the services listed on the booking form, used if the
// services table has no matching row.
const SERVICE_DURATIONS = {
  'manicure': 30,
  'pedicure': 45,
  'gel-mani': 45,
  'gel-pedi': 45,
  'dip': 45,
  'acrylic': 60,
  'nail-art': 30,
  'brow-consult': 30,
  'microblading': 120,
  'lip-blush': 90,
  'lip-refresh': 60
};

// Returns the UTC Date for a wall-clock time in the salon's time zone.
function salonTime(date, hour, min) {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: TIME_ZONE }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (utc - local));
}

function dbError(label, error) {
  console.error(`Supabase error (${label}):`, error.message, error.hint || '');
  return { statusCode: 500, body: JSON.stringify({ error: 'Could not read booking data' }) };
}

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
    const { data: service, error: serviceError } = await supabase
      .from('services')
      .select('duration_minutes')
      .eq('id', service_id)
      .maybeSingle();

    if (serviceError) return dbError('services', serviceError);

    const durationMinutes = service?.duration_minutes || SERVICE_DURATIONS[service_id];

    if (!durationMinutes) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Service not found' }) };
    }

    // Get day of week
    const selectedDate = new Date(date);
    const dayOfWeek = selectedDate.getUTCDay() === 0 ? 6 : selectedDate.getUTCDay() - 1;

    // Get staff availability
    let query = supabase
      .from('availability')
      .select('staff_id, start_time, end_time')
      .eq('day_of_week', dayOfWeek);

    if (staff_id) {
      query = query.eq('staff_id', staff_id);
    }

    const { data: availableSlots, error: availabilityError } = await query;

    if (availabilityError) return dbError('availability', availabilityError);

    if (!availableSlots || availableSlots.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ available_slots: [] }) };
    }

    // Get booked appointments
    const startOfDay = salonTime(date, 0, 0).toISOString();
    const endOfDay = new Date(salonTime(date, 23, 59).getTime() + 59000).toISOString();

    const { data: booked, error: bookedError } = await supabase
      .from('appointments')
      .select('appointment_time')
      .gte('appointment_time', startOfDay)
      .lte('appointment_time', endOfDay)
      .eq('status', 'booked');

    if (bookedError) return dbError('appointments', bookedError);

    // Generate time slots (9am–7pm salon time)
    const slots = [];
    for (let hour = 9; hour < 19; hour++) {
      for (let min = 0; min < 60; min += 30) {
        const slotTime = salonTime(date, hour, min);

        const isBooked = booked?.some(apt => {
          const aptTime = new Date(apt.appointment_time);
          const aptEnd = new Date(aptTime.getTime() + durationMinutes * 60000);
          return slotTime >= aptTime && slotTime < aptEnd;
        });

        if (!isBooked) {
          slots.push({
            time: slotTime.toISOString(),
            time_display: slotTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIME_ZONE })
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
