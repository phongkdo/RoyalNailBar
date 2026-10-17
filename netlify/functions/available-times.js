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

    let { service_id, date, staff_id } = JSON.parse(event.body);

    if (!service_id || !date) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing service_id or date' }) };
    }

    // Convert staff_id to string for consistent comparison with database values
    if (staff_id) {
      staff_id = String(staff_id);
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

    const timeZone = 'America/New_York';
    const [year, month, day] = date.split('-').map(Number);

    // Create date in local time for day-of-week calculation
    const localDate = new Date(year, month - 1, day);
    const dayOfWeek = localDate.getDay() === 0 ? 6 : localDate.getDay() - 1;

    // Calculate timezone offset for EST (America/New_York)
    // This accounts for both standard time (UTC-5) and daylight saving (UTC-4)
    const refDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const estTimeStr = refDate.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const estHour = parseInt(estTimeStr.split(':')[0]);
    const tzOffset = estHour - 12; // How many hours EST is offset from UTC

    // Get staff availability for this day of week
    let availQuery = supabase
      .from('availability')
      .select('staff_id, start_time, end_time')
      .eq('day_of_week', dayOfWeek);

    if (staff_id) {
      availQuery = availQuery.eq('staff_id', staff_id);
    }

    const { data: staffAvailability } = await availQuery;

    if (!staffAvailability || staffAvailability.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ available_slots: [] }) };
    }

    // Get booked appointments for this date (EST)
    // If staff_id is provided, only get that staff's bookings
    // If no staff_id, get all staff bookings to check salon-wide availability
    const startOfDay = new Date(Date.UTC(year, month - 1, day, 0 - tzOffset, 0, 0));
    const endOfDay = new Date(Date.UTC(year, month - 1, day, 23 - tzOffset, 59, 59));

    const startISO = startOfDay.toISOString();
    const endISO = endOfDay.toISOString();

    let bookedQuery = supabase
      .from('appointments')
      .select('appointment_time, staff_id, service_id')
      .gte('appointment_time', startISO)
      .lte('appointment_time', endISO)
      .eq('status', 'booked');

    // Filter by specific technician if selected
    if (staff_id) {
      bookedQuery = bookedQuery.eq('staff_id', staff_id);
    }

    const { data: booked } = await bookedQuery;

    // Fetch service durations for booked appointments so we use THEIR duration for overlap check
    let bookedWithDurations = [];
    if (booked && booked.length > 0) {
      const serviceIds = [...new Set(booked.map(apt => apt.service_id).filter(Boolean))];
      
      if (serviceIds.length > 0) {
        const { data: services } = await supabase
          .from('services')
          .select('id, duration_minutes')
          .in('id', serviceIds);
        
        const serviceDurations = {};
        services?.forEach(svc => {
          serviceDurations[svc.id] = svc.duration_minutes;
        });

        bookedWithDurations = booked.map(apt => ({
          ...apt,
          duration: serviceDurations[apt.service_id] || 30 // Default 30 min if not found
        }));
      }
    }

    // Build staff availability map
    const staffAvailMap = {};
    staffAvailability.forEach(avail => {
      if (!staffAvailMap[avail.staff_id]) {
        staffAvailMap[avail.staff_id] = [];
      }
      staffAvailMap[avail.staff_id].push({
        start: avail.start_time,
        end: avail.end_time
      });
    });

    // Generate time slots from 9:00 AM to 7:00 PM (19:00) in EST
    const slots = [];
    for (let hour = 9; hour < 19; hour++) {
      for (let min = 0; min < 60; min += 30) {
        // Create slot time adjusted for timezone offset
        // Convert EST time to UTC by subtracting the offset
        const slotTime = new Date(Date.UTC(year, month - 1, day, hour - tzOffset, min, 0));
        const slotEndTime = new Date(slotTime.getTime() + service.duration_minutes * 60000);

        let slotAvailable = false;

        // Check if slot is available with at least one staff member
        for (const [staffMemberId, availWindows] of Object.entries(staffAvailMap)) {
          // If specific staff selected, only check that staff
          if (staff_id && staffMemberId !== staff_id) {
            continue;
          }

          // Check if slot falls within this staff member's availability window
          let withinWindow = false;
          for (const window of availWindows) {
            const [startHour, startMin] = window.start.split(':').map(Number);
            const [endHour, endMin] = window.end.split(':').map(Number);

            // Convert availability window times to UTC for comparison
            const windowStart = new Date(Date.UTC(year, month - 1, day, startHour - tzOffset, startMin, 0));
            const windowEnd = new Date(Date.UTC(year, month - 1, day, endHour - tzOffset, endMin, 0));

            // Check if entire slot fits within window
            if (slotTime >= windowStart && slotEndTime <= windowEnd) {
              withinWindow = true;
              break;
            }
          }

          if (!withinWindow) {
            continue; // This staff member not available in this window
          }

          // Check if this staff member has a conflicting booking
          const hasConflict = bookedWithDurations.some(apt => {
            // Compare staff IDs as strings to avoid type mismatches (number vs string)
            if (String(apt.staff_id) !== String(staffMemberId)) {
              return false; // Different staff member
            }
            const aptTime = new Date(apt.appointment_time);
            const aptEnd = new Date(aptTime.getTime() + apt.duration * 60000); // Use BOOKED service duration

            // Check for overlap: slot overlaps with appointment if:
            // slot starts before appointment ends AND slot ends after appointment starts
            return slotTime < aptEnd && slotEndTime > aptTime;
          });

          if (!hasConflict) {
            slotAvailable = true;
            break; // Found at least one staff member free at this time
          }
        }

        if (slotAvailable) {
          slots.push({
            time: slotTime.toISOString(),
            time_display: slotTime.toLocaleString('en-US', { 
              hour: '2-digit', 
              minute: '2-digit', 
              hour12: true,
              timeZone: timeZone
            })
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
