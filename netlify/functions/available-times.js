const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SALON_TZ = 'America/New_York';
const SLOT_MINUTES = 30;

// Offset in minutes that the salon timezone is east of UTC at a given instant
function tzOffsetMinutes(date) {
  const parts = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SALON_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  for (const { type, value } of dtf.formatToParts(date)) {
    parts[type] = value;
  }
  const asUtc = Date.UTC(
    +parts.year,
    parts.month - 1,
    +parts.day,
    parts.hour % 24,
    +parts.minute,
    +parts.second
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

// UTC instant for a salon-local wall time (hour/minute on the given date)
function salonWallToUtc(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    instant = wall - tzOffsetMinutes(new Date(instant)) * 60000;
  }
  return new Date(instant);
}

// Appointment times are stored as timestamps without time zone (naive UTC)
function parseStoredUtc(value) {
  let str = String(value).trim().replace(' ', 'T');
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)) {
    str += 'Z';
  }
  return new Date(str);
}

// "09:00:00" -> 540 minutes since salon-local midnight
function wallTimeToMinutes(value) {
  const [h, m] = String(value).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

const timeDisplay = new Intl.DateTimeFormat('en-US', {
  timeZone: SALON_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

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
    const durationMinutes = service.duration_minutes;

    // Parse date as a calendar date (YYYY-MM-DD from the date input)
    // day_of_week convention: Monday=0 ... Sunday=6
    const [year, month, day] = date.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day);
    const dayOfWeek = selectedDate.getDay() === 0 ? 6 : selectedDate.getDay() - 1;

    // Get staff availability for this day of week (start/end are salon-local wall times)
    let availabilityQuery = supabase
      .from('availability')
      .select('staff_id, start_time, end_time')
      .eq('day_of_week', dayOfWeek);

    if (staff_id) {
      availabilityQuery = availabilityQuery.eq('staff_id', staff_id);
    }

    const { data: windows } = await availabilityQuery;

    if (!windows || windows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ available_slots: [] }) };
    }

    // Get booked appointments for this date (naive UTC instants)
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0).toISOString();
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59).toISOString();

    const { data: booked } = await supabase
      .from('appointments')
      .select('appointment_time, service_id, staff_id')
      .gte('appointment_time', startOfDay)
      .lte('appointment_time', endOfDay)
      .eq('status', 'booked');

    // Look up each booked appointment's own service duration so overlap is accurate
    const bookedServiceIds = [...new Set((booked || []).map(a => a.service_id).filter(Boolean))];
    let durationsById = {};
    if (bookedServiceIds.length > 0) {
      const { data: bookedServices } = await supabase
        .from('services')
        .select('id, duration_minutes')
        .in('id', bookedServiceIds);
      durationsById = Object.fromEntries((bookedServices || []).map(s => [s.id, s.duration_minutes]));
    }

    const slots = [];
    const minStart = Math.min(...windows.map(w => wallTimeToMinutes(w.start_time)));
    const maxEnd = Math.max(...windows.map(w => wallTimeToMinutes(w.end_time)));

    for (let minutes = minStart; minutes + durationMinutes <= maxEnd; minutes += SLOT_MINUTES) {
      const hour = Math.floor(minutes / 60);
      const minute = minutes % 60;
      const slotStart = salonWallToUtc(year, month, day, hour, minute);

      // At least one eligible technician must cover the whole service inside their window
      const hasStaff = windows.some(w => {
        return minutes >= wallTimeToMinutes(w.start_time) && (minutes + durationMinutes) <= wallTimeToMinutes(w.end_time);
      });
      if (!hasStaff) continue;

      // Blocked if it overlaps a booking for the selected technician
      // (or any booking when no technician is chosen; bookings without a
      // technician assigned block everyone since the technician is unknown)
      const isBooked = (booked || []).some(apt => {
        if (staff_id && apt.staff_id != null && String(apt.staff_id) !== String(staff_id)) {
          return false;
        }
        const aptStart = parseStoredUtc(apt.appointment_time);
        const aptDuration = durationsById[apt.service_id] || durationMinutes;
        const aptEnd = new Date(aptStart.getTime() + aptDuration * 60000);
        return slotStart < aptEnd && slotStart >= aptStart;
      });

      if (!isBooked) {
        slots.push({
          time: slotStart.toISOString(),
          time_display: timeDisplay.format(slotStart)
        });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ available_slots: slots }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error', details: error.message }) };
  }
};