const DEFAULT_TIMEZONE_REGION_ID = `us`;

const TIMEZONE_GROUPS = [
	{
		description: `US mainland, Alaska, and Hawaii`,
		id: `us`,
		label: `United States`,
		timezones: [
			{ label: `US Eastern (New York)`, value: `America/New_York` },
			{ label: `US Central (Chicago)`, value: `America/Chicago` },
			{ label: `US Mountain (Denver)`, value: `America/Denver` },
			{ label: `US Mountain No DST (Phoenix)`, value: `America/Phoenix` },
			{ label: `US Pacific (Los Angeles)`, value: `America/Los_Angeles` },
			{ label: `US Alaska (Anchorage)`, value: `America/Anchorage` },
			{ label: `US Hawaii (Honolulu)`, value: `Pacific/Honolulu` },
		],
	},
	{
		description: `Canada, Mexico, and South America`,
		id: `americas`,
		label: `Americas`,
		timezones: [
			{ label: `Canada Eastern (Toronto)`, value: `America/Toronto` },
			{ label: `Canada Pacific (Vancouver)`, value: `America/Vancouver` },
			{ label: `Mexico City`, value: `America/Mexico_City` },
			{ label: `Brazil (Sao Paulo)`, value: `America/Sao_Paulo` },
		],
	},
	{
		description: `Common European timezones`,
		id: `europe`,
		label: `Europe`,
		timezones: [
			{ label: `UK (London)`, value: `Europe/London` },
			{ label: `Ireland (Dublin)`, value: `Europe/Dublin` },
			{ label: `Portugal (Lisbon)`, value: `Europe/Lisbon` },
			{ label: `France (Paris)`, value: `Europe/Paris` },
			{ label: `Germany (Berlin)`, value: `Europe/Berlin` },
			{ label: `Italy (Rome)`, value: `Europe/Rome` },
			{ label: `Spain (Madrid)`, value: `Europe/Madrid` },
			{ label: `Netherlands (Amsterdam)`, value: `Europe/Amsterdam` },
			{ label: `Poland (Warsaw)`, value: `Europe/Warsaw` },
			{ label: `Greece (Athens)`, value: `Europe/Athens` },
		],
	},
	{
		description: `Africa and Middle East`,
		id: `africa_middle_east`,
		label: `Africa / Middle East`,
		timezones: [
			{ label: `South Africa (Johannesburg)`, value: `Africa/Johannesburg` },
			{ label: `Egypt (Cairo)`, value: `Africa/Cairo` },
			{ label: `UAE (Dubai)`, value: `Asia/Dubai` },
		],
	},
	{
		description: `Common Asian timezones`,
		id: `asia`,
		label: `Asia`,
		timezones: [
			{ label: `India (Kolkata)`, value: `Asia/Kolkata` },
			{ label: `Singapore`, value: `Asia/Singapore` },
			{ label: `Philippines (Manila)`, value: `Asia/Manila` },
			{ label: `Hong Kong`, value: `Asia/Hong_Kong` },
			{ label: `China (Shanghai)`, value: `Asia/Shanghai` },
			{ label: `South Korea (Seoul)`, value: `Asia/Seoul` },
			{ label: `Japan (Tokyo)`, value: `Asia/Tokyo` },
		],
	},
	{
		description: `Australia, New Zealand, and Pacific`,
		id: `oceania`,
		label: `Oceania`,
		timezones: [
			{ label: `Australia Western (Perth)`, value: `Australia/Perth` },
			{ label: `Australia Central (Adelaide)`, value: `Australia/Adelaide` },
			{ label: `Australia Queensland (Brisbane)`, value: `Australia/Brisbane` },
			{ label: `Australia Eastern (Sydney)`, value: `Australia/Sydney` },
			{ label: `Australia Eastern (Melbourne)`, value: `Australia/Melbourne` },
			{ label: `New Zealand (Auckland)`, value: `Pacific/Auckland` },
		],
	},
	{
		description: `Coordinated Universal Time`,
		id: `utc`,
		label: `UTC`,
		timezones: [
			{ label: `UTC`, value: `UTC` },
		],
	},
];

const TIMEZONE_CHOICES = TIMEZONE_GROUPS.flatMap(group => group.timezones);

function getTimezoneGroup(regionId) {
	return TIMEZONE_GROUPS.find(group => group.id === regionId) || TIMEZONE_GROUPS.find(group => group.id === DEFAULT_TIMEZONE_REGION_ID);
}

function getTimezoneRegionId(timezone) {
	if (!timezone) {
		return DEFAULT_TIMEZONE_REGION_ID;
	}

	const group = TIMEZONE_GROUPS.find(timezoneGroup =>
		timezoneGroup.timezones.some(choice => choice.value === timezone),
	);

	if (group) {
		return group.id;
	}

	if (timezone === `UTC` || timezone.startsWith(`Etc/`)) {
		return `utc`;
	}

	if (timezone.startsWith(`Europe/`)) {
		return `europe`;
	}

	if (timezone.startsWith(`Africa/`)) {
		return `africa_middle_east`;
	}

	if (timezone.startsWith(`Asia/`)) {
		return `asia`;
	}

	if (timezone.startsWith(`Australia/`) || timezone.startsWith(`Pacific/`)) {
		return `oceania`;
	}

	if (timezone.startsWith(`America/`)) {
		return `americas`;
	}

	return DEFAULT_TIMEZONE_REGION_ID;
}

function getTimezoneChoicesForRegion(regionId, selectedTimezone = null) {
	const group = getTimezoneGroup(regionId);
	const choices = [...group.timezones];

	if (
		selectedTimezone &&
		getTimezoneRegionId(selectedTimezone) === group.id &&
		!choices.some(choice => choice.value === selectedTimezone)
	) {
		choices.unshift({
			label: `Current (${selectedTimezone})`,
			value: selectedTimezone,
		});
	}

	return choices.slice(0, 25);
}

module.exports = {
	DEFAULT_TIMEZONE_REGION_ID,
	TIMEZONE_CHOICES,
	TIMEZONE_GROUPS,
	getTimezoneChoicesForRegion,
	getTimezoneRegionId,
};
