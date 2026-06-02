function dateToString(input) {
	const newDate = new Date(input);
	let month = newDate.getMonth() + 1;
	month = month.toString().padStart(2, `0`);
	const day = newDate.getDate().toString().padStart(2, `0`);
	const year = newDate.getFullYear();
	const date = month + `/` + day + `/` + year;
	let hours = newDate.getHours();
	const minutes = newDate.getMinutes().toString().padStart(2, `0`);
	const ampm = hours >= 12 ? `pm` : `am`;
	hours = hours % 12;
	hours = hours ? hours : 12;
	const time = hours + `:` + minutes + ` ` + ampm;

	return `${date} at ${time}`;
}
module.exports = { dateToString };