// A device's recurring notification window. Null preserves the existing anytime behavior.
export const NOTIFICATION_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const NOTIFICATION_TIMES = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  return {
    value: `${String(hour).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
    label: `${hour % 12 || 12}:${index % 2 ? "30" : "00"} ${hour < 12 ? "AM" : "PM"}`,
  };
});
export function workHoursSchedule(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timeZone };
}
// Hermes lacks supportedValuesOf; keep the same IANA choices available on phones.
const FALLBACK_TIME_ZONES = `Africa/Abidjan Africa/Accra Africa/Addis_Ababa Africa/Algiers Africa/Asmera Africa/Bamako Africa/Bangui Africa/Banjul Africa/Bissau
Africa/Blantyre Africa/Brazzaville Africa/Bujumbura Africa/Cairo Africa/Casablanca Africa/Ceuta Africa/Conakry Africa/Dakar
Africa/Dar_es_Salaam Africa/Djibouti Africa/Douala Africa/El_Aaiun Africa/Freetown Africa/Gaborone Africa/Harare Africa/Johannesburg
Africa/Juba Africa/Kampala Africa/Khartoum Africa/Kigali Africa/Kinshasa Africa/Lagos Africa/Libreville Africa/Lome Africa/Luanda
Africa/Lubumbashi Africa/Lusaka Africa/Malabo Africa/Maputo Africa/Maseru Africa/Mbabane Africa/Mogadishu Africa/Monrovia Africa/Nairobi
Africa/Ndjamena Africa/Niamey Africa/Nouakchott Africa/Ouagadougou Africa/Porto-Novo Africa/Sao_Tome Africa/Tripoli Africa/Tunis
Africa/Windhoek America/Adak America/Anchorage America/Anguilla America/Antigua America/Araguaina America/Argentina/La_Rioja
America/Argentina/Rio_Gallegos America/Argentina/Salta America/Argentina/San_Juan America/Argentina/San_Luis America/Argentina/Tucuman
America/Argentina/Ushuaia America/Aruba America/Asuncion America/Bahia America/Bahia_Banderas America/Barbados America/Belem America/Belize
America/Blanc-Sablon America/Boa_Vista America/Bogota America/Boise America/Buenos_Aires America/Cambridge_Bay America/Campo_Grande
America/Cancun America/Caracas America/Catamarca America/Cayenne America/Cayman America/Chicago America/Chihuahua America/Ciudad_Juarez
America/Coral_Harbour America/Cordoba America/Costa_Rica America/Coyhaique America/Creston America/Cuiaba America/Curacao
America/Danmarkshavn America/Dawson America/Dawson_Creek America/Denver America/Detroit America/Dominica America/Edmonton America/Eirunepe
America/El_Salvador America/Fort_Nelson America/Fortaleza America/Glace_Bay America/Godthab America/Goose_Bay America/Grand_Turk
America/Grenada America/Guadeloupe America/Guatemala America/Guayaquil America/Guyana America/Halifax America/Havana America/Hermosillo
America/Indiana/Knox America/Indiana/Marengo America/Indiana/Petersburg America/Indiana/Tell_City America/Indiana/Vevay
America/Indiana/Vincennes America/Indiana/Winamac America/Indianapolis America/Inuvik America/Iqaluit America/Jamaica America/Jujuy
America/Juneau America/Kentucky/Monticello America/Kralendijk America/La_Paz America/Lima America/Los_Angeles America/Louisville
America/Lower_Princes America/Maceio America/Managua America/Manaus America/Marigot America/Martinique America/Matamoros America/Mazatlan
America/Mendoza America/Menominee America/Merida America/Metlakatla America/Mexico_City America/Miquelon America/Moncton America/Monterrey
America/Montevideo America/Montserrat America/Nassau America/New_York America/Nome America/Noronha America/North_Dakota/Beulah
America/North_Dakota/Center America/North_Dakota/New_Salem America/Ojinaga America/Panama America/Paramaribo America/Phoenix
America/Port-au-Prince America/Port_of_Spain America/Porto_Velho America/Puerto_Rico America/Punta_Arenas America/Rankin_Inlet America/Recife
America/Regina America/Resolute America/Rio_Branco America/Santarem America/Santiago America/Santo_Domingo America/Sao_Paulo
America/Scoresbysund America/Sitka America/St_Barthelemy America/St_Johns America/St_Kitts America/St_Lucia America/St_Thomas
America/St_Vincent America/Swift_Current America/Tegucigalpa America/Thule America/Tijuana America/Toronto America/Tortola America/Vancouver
America/Whitehorse America/Winnipeg America/Yakutat Antarctica/Casey Antarctica/Davis Antarctica/DumontDUrville Antarctica/Macquarie
Antarctica/Mawson Antarctica/McMurdo Antarctica/Palmer Antarctica/Rothera Antarctica/Syowa Antarctica/Troll Antarctica/Vostok
Arctic/Longyearbyen Asia/Aden Asia/Almaty Asia/Amman Asia/Anadyr Asia/Aqtau Asia/Aqtobe Asia/Ashgabat Asia/Atyrau Asia/Baghdad Asia/Bahrain
Asia/Baku Asia/Bangkok Asia/Barnaul Asia/Beirut Asia/Bishkek Asia/Brunei Asia/Calcutta Asia/Chita Asia/Colombo Asia/Damascus Asia/Dhaka
Asia/Dili Asia/Dubai Asia/Dushanbe Asia/Famagusta Asia/Gaza Asia/Hebron Asia/Hong_Kong Asia/Hovd Asia/Irkutsk Asia/Jakarta Asia/Jayapura
Asia/Jerusalem Asia/Kabul Asia/Kamchatka Asia/Karachi Asia/Katmandu Asia/Khandyga Asia/Krasnoyarsk Asia/Kuala_Lumpur Asia/Kuching Asia/Kuwait
Asia/Macau Asia/Magadan Asia/Makassar Asia/Manila Asia/Muscat Asia/Nicosia Asia/Novokuznetsk Asia/Novosibirsk Asia/Omsk Asia/Oral
Asia/Phnom_Penh Asia/Pontianak Asia/Pyongyang Asia/Qatar Asia/Qostanay Asia/Qyzylorda Asia/Rangoon Asia/Riyadh Asia/Saigon Asia/Sakhalin
Asia/Samarkand Asia/Seoul Asia/Shanghai Asia/Singapore Asia/Srednekolymsk Asia/Taipei Asia/Tashkent Asia/Tbilisi Asia/Tehran Asia/Thimphu
Asia/Tokyo Asia/Tomsk Asia/Ulaanbaatar Asia/Urumqi Asia/Ust-Nera Asia/Vientiane Asia/Vladivostok Asia/Yakutsk Asia/Yekaterinburg Asia/Yerevan
Atlantic/Azores Atlantic/Bermuda Atlantic/Canary Atlantic/Cape_Verde Atlantic/Faeroe Atlantic/Madeira Atlantic/Reykjavik
Atlantic/South_Georgia Atlantic/St_Helena Atlantic/Stanley Australia/Adelaide Australia/Brisbane Australia/Broken_Hill Australia/Darwin
Australia/Eucla Australia/Hobart Australia/Lindeman Australia/Lord_Howe Australia/Melbourne Australia/Perth Australia/Sydney Europe/Amsterdam
Europe/Andorra Europe/Astrakhan Europe/Athens Europe/Belgrade Europe/Berlin Europe/Bratislava Europe/Brussels Europe/Bucharest
Europe/Budapest Europe/Busingen Europe/Chisinau Europe/Copenhagen Europe/Dublin Europe/Gibraltar Europe/Guernsey Europe/Helsinki
Europe/Isle_of_Man Europe/Istanbul Europe/Jersey Europe/Kaliningrad Europe/Kiev Europe/Kirov Europe/Lisbon Europe/Ljubljana Europe/London
Europe/Luxembourg Europe/Madrid Europe/Malta Europe/Mariehamn Europe/Minsk Europe/Monaco Europe/Moscow Europe/Oslo Europe/Paris
Europe/Podgorica Europe/Prague Europe/Riga Europe/Rome Europe/Samara Europe/San_Marino Europe/Sarajevo Europe/Saratov Europe/Simferopol
Europe/Skopje Europe/Sofia Europe/Stockholm Europe/Tallinn Europe/Tirane Europe/Ulyanovsk Europe/Vaduz Europe/Vatican Europe/Vienna
Europe/Vilnius Europe/Volgograd Europe/Warsaw Europe/Zagreb Europe/Zurich Indian/Antananarivo Indian/Chagos Indian/Christmas Indian/Cocos
Indian/Comoro Indian/Kerguelen Indian/Mahe Indian/Maldives Indian/Mauritius Indian/Mayotte Indian/Reunion Pacific/Apia Pacific/Auckland
Pacific/Bougainville Pacific/Chatham Pacific/Easter Pacific/Efate Pacific/Enderbury Pacific/Fakaofo Pacific/Fiji Pacific/Funafuti
Pacific/Galapagos Pacific/Gambier Pacific/Guadalcanal Pacific/Guam Pacific/Honolulu Pacific/Kiritimati Pacific/Kosrae Pacific/Kwajalein
Pacific/Majuro Pacific/Marquesas Pacific/Midway Pacific/Nauru Pacific/Niue Pacific/Norfolk Pacific/Noumea Pacific/Pago_Pago Pacific/Palau
Pacific/Pitcairn Pacific/Ponape Pacific/Port_Moresby Pacific/Rarotonga Pacific/Saipan Pacific/Tahiti Pacific/Tarawa Pacific/Tongatapu
Pacific/Truk Pacific/Wake Pacific/Wallis`.split(/\s+/);
export function notificationTimeZones() {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : FALLBACK_TIME_ZONES;
  return [...new Set([local, "UTC", ...zones])];
}
const formatters = new Map();
function formatter(timeZone) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
    formatters.set(timeZone, value);
  }
  return value;
}
const validTime = (time) => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
export function parseNotificationSchedule(value) {
  if (value == null) return null;
  if (
    typeof value !== "object" ||
    !Array.isArray(value.days) ||
    !value.days.length ||
    value.days.length > 7 ||
    !value.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
    !validTime(value.start) ||
    !validTime(value.end) ||
    value.start === value.end ||
    typeof value.timeZone !== "string" ||
    value.timeZone.length > 100
  )
    throw new Error("Invalid notification schedule");
  try {
    formatter(value.timeZone);
  } catch {
    throw new Error("Invalid notification schedule timezone");
  }
  return {
    days: NOTIFICATION_DAYS.map((_, day) => day).filter((day) => value.days.includes(day)),
    start: value.start,
    end: value.end,
    timeZone: value.timeZone,
  };
}
export function notificationAllowed(schedule, now = Date.now()) {
  if (!schedule) return true;
  // Read wall time in the device's chosen zone, never the sending computer's local zone.
  const parts = Object.fromEntries(
    formatter(schedule.timeZone)
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  const day = NOTIFICATION_DAYS.indexOf(parts.weekday);
  const time = `${parts.hour}:${parts.minute}`;
  if (schedule.start < schedule.end) return schedule.days.includes(day) && time >= schedule.start && time < schedule.end;
  return (schedule.days.includes(day) && time >= schedule.start) || (schedule.days.includes((day + 6) % 7) && time < schedule.end);
}
