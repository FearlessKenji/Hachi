function dateToString(a) {
	a = new Date(a);
	let month = a.getMonth() + 1;
	month = month.toString().padStart(2, `0`);
	const day = a.getDate().toString().padStart(2, `0`);
	const year = a.getFullYear();
	const date = month + `/` + day + `/` + year;
	let hours = a.getHours();
	const minutes = a.getMinutes().toString().padStart(2, `0`);
	const ampm = hours >= 12 ? `pm` : `am`;
	hours = hours % 12;
	hours = hours ? hours : 12;
	const time = hours + `:` + minutes + ` ` + ampm;

	return `${date} at ${time}`;
}
module.exports = { dateToString };