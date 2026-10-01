import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const clockLine = (zone: string, at: Date | number = Date.now()) => `Current time: ${dayjs(at).tz(zone).format("dddd YYYY-MM-DD HH:mm Z")} (${zone})`;

export { dayjs };
