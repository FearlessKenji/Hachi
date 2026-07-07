const WebSocket = require(`ws`);
const { TwitchRoleConfigs, TwitchRoleEventMessages } = require(`../database/dbObjects.js`);
const {
	applyTwitchRoleEvent,
	helixRequest,
} = require(`./twitchRoles.js`);
const { info, warn, error } = require(`../utils/writeLog.js`);

const EVENTSUB_WEBSOCKET_URL = `wss://eventsub.wss.twitch.tv/ws`;
const RECONNECT_DELAY_MS = 15000;
const SUBSCRIPTION_TYPES = [
	{ roleType: `vip`, shouldHave: true, type: `channel.vip.add` },
	{ roleType: `vip`, shouldHave: false, type: `channel.vip.remove` },
	{ roleType: `moderator`, shouldHave: true, type: `channel.moderator.add` },
	{ roleType: `moderator`, shouldHave: false, type: `channel.moderator.remove` },
];

let activeService = null;

function eventDetails(subscriptionType) {
	return SUBSCRIPTION_TYPES.find(details => details.type === subscriptionType) || null;
}

function createService(client) {
	let socket = null;
	let reconnectTimer = null;
	let stopped = false;

	function clearReconnectTimer() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	}

	function scheduleReconnect() {
		if (stopped || reconnectTimer) {
			return;
		}

		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect(EVENTSUB_WEBSOCKET_URL);
		}, RECONNECT_DELAY_MS);
	}

	async function getBroadcasterConfigs() {
		const configs = await TwitchRoleConfigs.findAll({
			order: [[`guildId`, `ASC`]],
		});

		return configs.filter(config =>
			config.broadcasterTwitchUserId &&
			(config.vipRoleId || config.moderatorRoleId),
		);
	}

	async function subscribeConfig(sessionId, config) {
		for (const subscription of SUBSCRIPTION_TYPES) {
			const roleId = subscription.roleType === `vip` ?
				config.vipRoleId :
				config.moderatorRoleId;

			if (!roleId) {
				continue;
			}

			try {
				await helixRequest(config, `/eventsub/subscriptions`, {
					method: `POST`,
					acceptStatuses: [409],
					body: {
						type: subscription.type,
						version: `1`,
						condition: {
							broadcaster_user_id: config.broadcasterTwitchUserId,
						},
						transport: {
							method: `websocket`,
							session_id: sessionId,
						},
					},
				});
			} catch (err) {
				warn(`Failed to subscribe to ${subscription.type} for Twitch broadcaster ${config.broadcasterLogin || config.broadcasterTwitchUserId}: ${err.message}`);
			}
		}
	}

	async function subscribeSession(sessionId) {
		const configs = await getBroadcasterConfigs();

		if (!configs.length) {
			info(`Twitch role EventSub connected; no broadcaster role mappings configured.`);
			return;
		}

		await Promise.all(configs.map(config => subscribeConfig(sessionId, config)));
		info(`Twitch role EventSub subscribed for ${configs.length} broadcaster configuration(s).`);
	}

	async function markEventSeen(metadata, subscriptionType, event) {
		if (!metadata?.message_id) {
			return true;
		}

		const [record, created] = await TwitchRoleEventMessages.findOrCreate({
			where: { messageId: metadata.message_id },
			defaults: {
				messageId: metadata.message_id,
				subscriptionType,
				broadcasterTwitchUserId: event.broadcaster_user_id,
				twitchUserId: event.user_id,
				receivedAt: new Date(),
			},
		});

		return Boolean(record && created);
	}

	async function handleNotification(message) {
		const subscriptionType = message.payload?.subscription?.type;
		const details = eventDetails(subscriptionType);
		const event = message.payload?.event;

		if (!details || !event?.user_id || !event?.broadcaster_user_id) {
			return;
		}

		const isNew = await markEventSeen(message.metadata, subscriptionType, event);

		if (!isNew) {
			return;
		}

		const result = await applyTwitchRoleEvent(client, {
			broadcasterTwitchUserId: event.broadcaster_user_id,
			roleType: details.roleType,
			shouldHave: details.shouldHave,
			twitchUserId: event.user_id,
		});

		info(
			`Processed Twitch ${subscriptionType} for ${event.user_login || event.user_id}: ` +
			`added ${result.added}, removed ${result.removed}, skipped ${result.skipped}.`,
		);
	}

	async function handleMessage(ws, raw) {
		let message;

		try {
			message = JSON.parse(raw.toString());
		} catch (err) {
			warn(`Received invalid Twitch EventSub WebSocket message: ${err.message}`);
			return;
		}

		const messageType = message.metadata?.message_type;

		if (messageType === `session_welcome`) {
			const previousSocket = socket !== ws ? socket : null;
			const sessionId = message.payload?.session?.id;

			if (previousSocket && previousSocket.readyState === WebSocket.OPEN) {
				previousSocket.close(1000, `EventSub session replaced`);
			}

			if (sessionId) {
				await subscribeSession(sessionId);
			}
		} else if (messageType === `session_reconnect`) {
			const reconnectUrl = message.payload?.session?.reconnect_url;

			if (reconnectUrl) {
				connect(reconnectUrl);
			}
		} else if (messageType === `notification`) {
			await handleNotification(message);
		} else if (messageType === `revocation`) {
			warn(`Twitch EventSub subscription was revoked: ${message.payload?.subscription?.type || `unknown type`}.`);
		}
	}

	function connect(url) {
		if (stopped) {
			return;
		}

		clearReconnectTimer();

		const ws = new WebSocket(url);
		socket = ws;

		ws.on(`open`, () => {
			info(`Twitch role EventSub WebSocket connected.`);
		});

		ws.on(`message`, raw => {
			handleMessage(ws, raw).catch(err => error(`Failed to handle Twitch EventSub message:`, err));
		});

		ws.on(`close`, () => {
			if (socket === ws && !stopped) {
				warn(`Twitch role EventSub WebSocket closed; reconnecting soon.`);
				scheduleReconnect();
			}
		});

		ws.on(`error`, err => {
			warn(`Twitch role EventSub WebSocket error: ${err.message}`);
		});
	}

	function start() {
		stopped = false;
		connect(EVENTSUB_WEBSOCKET_URL);
	}

	function stop() {
		stopped = true;
		clearReconnectTimer();

		if (socket) {
			socket.close(1000, `Hachi shutting down`);
			socket = null;
		}
	}

	function restart() {
		clearReconnectTimer();

		if (socket) {
			socket.close(1000, `Hachi refreshing Twitch EventSub subscriptions`);
			socket = null;
		}

		if (!stopped) {
			connect(EVENTSUB_WEBSOCKET_URL);
		}
	}

	return {
		restart,
		start,
		stop,
	};
}

function startTwitchRoleEventSub(client) {
	if (activeService) {
		return activeService;
	}

	activeService = createService(client);
	activeService.start();
	return activeService;
}

function stopTwitchRoleEventSub() {
	if (!activeService) {
		return;
	}

	activeService.stop();
	activeService = null;
}

module.exports = {
	startTwitchRoleEventSub,
	stopTwitchRoleEventSub,
};
