const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require(`discord.js`);

const { Servers, Channels } = require(`../../../database/dbObjects.js`);
const { error: logError } = require(`../../../utils/writeLog.js`);

const pendingAdds = new Map();

function formatYesNo(value) {
	if (value === null) {
		return `Not Set`;
	}

	return value ? `Yes` : `No`;
}

function formatDiscord(value) {
	return value ? `<${value}>` : `Not provided`;
}

function buildAddContent(pendingAdd) {
	const submitMessage = pendingAdd.needsSelections ? `\n### Select every option before submitting.` : ``;
	const title = pendingAdd.isEditing ?
		`## Edit Stream` :
		`## Add Stream`;

	return `${title}
- Name: **${pendingAdd.channelName}**
- Discord: ${formatDiscord(pendingAdd.discordUrl)}
- Twitch Notifications: ${formatYesNo(pendingAdd.twitchNotif)}
- Kick Notifications: ${formatYesNo(pendingAdd.kickNotif)}
- Your Stream: ${formatYesNo(pendingAdd.isSelf)}${submitMessage}`;
}

function buildCompleteContent(pendingAdd) {
	return `${buildAddContent(pendingAdd)}
### Stream saved.`;
}

function buildYesNoComponents(customId, placeholder) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder)
			.addOptions(
				new StringSelectMenuOptionBuilder()
					.setLabel(`Yes`)
					.setValue(`yes`),
				new StringSelectMenuOptionBuilder()
					.setLabel(`No`)
					.setValue(`no`),
			),
	);
}

function buildAddComponents(addId) {
	return [
		buildYesNoComponents(`stream:${addId}:setting:twitch`, `Post Twitch streams?`),
		buildYesNoComponents(`stream:${addId}:setting:kick`, `Post Kick streams?`),
		buildYesNoComponents(`stream:${addId}:setting:self`, `Is this your stream?`),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`stream:${addId}:submit`)
				.setLabel(`Submit`)
				.setStyle(ButtonStyle.Success),
		),
	];
}

function selectedYes(interaction) {
	return interaction.values[0] === `yes`;
}

function buildPendingAdd(interaction) {
	return {
		channelName: interaction.options.getString(`name`).toLowerCase().trim(),
		discordUrl: interaction.options.getString(`discord`) || null,
		guildId: interaction.guild.id,
		isSelf: null,
		kickNotif: null,
		needsSelections: false,
		twitchNotif: null,
		userId: interaction.user.id,
	};
}

async function getPendingAdd(interaction, addId) {
	const pendingAdd = pendingAdds.get(addId);
	if (!pendingAdd || pendingAdd.userId !== interaction.user.id || pendingAdd.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This request has timed out. Run \`/stream add\` again.`,
			components: [],
		});
		return;
	}

	return pendingAdd;
}

async function updatePanel(interaction, pendingAdd, components) {
	await interaction.update({
		content: buildAddContent(pendingAdd),
		components,
	});
}

async function showAdd(interaction, addId, pendingAdd) {
	await updatePanel(
		interaction,
		pendingAdd,
		buildAddComponents(addId),
	);
}

async function showComplete(interaction, pendingAdd) {
	await interaction.update({
		content: buildCompleteContent(pendingAdd),
		components: [],
	});
}

async function savePendingAdd(interaction, addId, pendingAdd) {
	await Servers.upsert({ guildId: pendingAdd.guildId });
	await Channels.upsert({
		channelName: pendingAdd.channelName,
		discordUrl: pendingAdd.discordUrl,
		guildId: pendingAdd.guildId,
		isSelf: pendingAdd.isSelf,
		twitchNotif: pendingAdd.twitchNotif,
		kickNotif: pendingAdd.kickNotif,
	});

	pendingAdds.delete(addId);
	await showComplete(interaction, pendingAdd);
}

async function startAdd(interaction) {

	const channelName = interaction.options.getString(`name`).toLowerCase().trim();
	const existingChannel = await Channels.findOne({
		where: {
			channelName,
			guildId: interaction.guild.id,
		},
		raw: true,
	});

	const addId = interaction.id;
	const pendingAdd = existingChannel ?
		{
			...existingChannel,
			userId: interaction.user.id,
			guildId: interaction.guild.id,
			needsSelections: false,
			isEditing: true,
		} :
		{
			...buildPendingAdd(interaction),
			isEditing: false,
		};

	pendingAdds.set(addId, pendingAdd);

	await interaction.reply({
		content: buildAddContent(pendingAdd),
		components: buildAddComponents(addId),
		flags: MessageFlags.Ephemeral,
	});
}

async function removeChannel(interaction) {
	const channelName = interaction.options.getString(`name`).toLowerCase().trim();
	const guildId = interaction.guild.id;

	const removed = await Channels.destroy({
		where: { channelName, guildId },
	});

	if (!removed) {
		await interaction.reply({
			content: `Channel **${channelName}** not found in database.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		content: `Removed **${channelName}** successfully.`,
		flags: MessageFlags.Ephemeral,
	});
}

function buildChannelList(channels) {
	return channels.map(chan =>
		`- **${chan.channelName}** ${chan.isSelf ? `(self)` : `(affiliate)`} ${chan.twitchNotif ? `(Twitch notify)` : ``} ${chan.kickNotif ? `(Kick notify)` : ``}`,
	);
}

async function listChannels(interaction) {
	const channels = await Channels.findAll({
		where: { guildId: interaction.guild.id },
		raw: true,
	});

	if (!channels.length) {
		await interaction.reply({
			content: `No stream channels configured.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		content: `**Stream Channels:**\n${buildChannelList(channels).join(`\n`)}`,
		flags: MessageFlags.Ephemeral,
	});
}

async function handleAddSelection(interaction, step, addId) {
	const pendingAdd = await getPendingAdd(interaction, addId);

	if (!pendingAdd) {
		return;
	}

	if (step === `twitch`) {
		pendingAdd.twitchNotif = selectedYes(interaction);
	} else if (step === `kick`) {
		pendingAdd.kickNotif = selectedYes(interaction);
	} else if (step === `self`) {
		pendingAdd.isSelf = selectedYes(interaction);
	}

	pendingAdd.needsSelections = false;
	await showAdd(interaction, addId, pendingAdd);
}

async function handleSubmit(interaction, addId) {
	const pendingAdd = await getPendingAdd(interaction, addId);

	if (!pendingAdd) {
		return;
	}

	if (pendingAdd.twitchNotif === null || pendingAdd.kickNotif === null || pendingAdd.isSelf === null) {
		pendingAdd.needsSelections = true;
		await showAdd(interaction, addId, pendingAdd);
		return;
	}

	await savePendingAdd(interaction, addId, pendingAdd);
}

async function handleAddComponent(interaction, addId, action, field) {
	if (action === `setting`) {
		await handleAddSelection(interaction, field, addId);
	} else if (action === `submit`) {
		await handleSubmit(interaction, addId);
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`stream`)
		.setDescription(`Stream options.`)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`add`)
				.setDescription(`Add or edit a channel. Tab to add optional Discord invite link.`)
				.addStringOption(option =>
					option.setName(`name`)
						.setDescription(`Username.`)
						.setRequired(true),
				)
				.addStringOption(option =>
					option.setName(`discord`)
						.setDescription(`Discord invite URL for the channel. Shows in embed.`),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`remove`)
				.setDescription(`Remove a channel from the list.`)
				.addStringOption(option =>
					option.setName(`name`)
						.setDescription(`Username to remove.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`list`)
				.setDescription(`List all channels for this server and their configurations.`),
		)
		.setDefaultMemberPermissions(0) // Restrict to admins or bot owner,
		.setContexts(InteractionContextType.Guild),

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		try {
			if (subcommand === `add`) {
				await startAdd(interaction);
			} else if (subcommand === `remove`) {
				await removeChannel(interaction);
			} else if (subcommand === `list`) {
				await listChannels(interaction);
			}
		} catch (err) {
			logError(`Failed to execute command ${subcommand}:`, err);
			await interaction.reply({
				content: `Failed to execute command ${subcommand}.`,
				flags: MessageFlags.Ephemeral,
			});
		}
	},

	async handleComponent(interaction) {
		const [, addId, action, field] = interaction.customId.split(`:`);

		try {
			await handleAddComponent(interaction, addId, action, field);
		} catch (err) {
			logError(`Failed to add stream settings:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to add stream settings.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to add stream settings.`, flags: MessageFlags.Ephemeral });
			}
		}
	},
};
