const { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Path to the embeds definition file
const EMBEDS_FILE_PATH = path.join(__dirname, '../embeds.json');
// Path to the buttons definition file
const BUTTONS_FILE_PATH = path.join(__dirname, '../buttons.json');

// Replace variables in text
function replaceVariables(text, variables) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (match, variableName) => {
    return variables[variableName] !== undefined ? variables[variableName] : match;
  });
}

// Process content recursively
function processContent(content, variables) {
  if (typeof content === 'string') {
    return replaceVariables(content, variables);
  }
  
  if (Array.isArray(content)) {
    return content.map(item => processContent(item, variables));
  }
  
  if (content !== null && typeof content === 'object') {
    const newObject = {};
    for (const key in content) {
      newObject[key] = processContent(content[key], variables);
    }
    return newObject;
  }
  
  return content;
}

// Get embed by key
function getEmbed(key, variables = {}) {
  try {
    // Read file fresh for updates
    const fileContent = fs.readFileSync(EMBEDS_FILE_PATH, 'utf8');
    const embedsConfig = JSON.parse(fileContent);

    // Navigate the JSON object using the key
    const parts = key.split('.');
    let current = embedsConfig;
    
    for (const part of parts) {
      if (current[part] === undefined) {
        throw new Error(`Embed key '${key}' not found in configuration.`);
      }
      current = current[part];
    }

    // Deep copy and process variables
    const embedData = processContent(current, variables);

    // Build the embed
    const embed = new EmbedBuilder();

    if (embedData.title) embed.setTitle(embedData.title);
    if (embedData.description) embed.setDescription(embedData.description);
    if (embedData.color) embed.setColor(embedData.color);
    
    if (embedData.fields && Array.isArray(embedData.fields)) {
      embed.addFields(embedData.fields);
    }
    
    if (embedData.footer) {
      embed.setFooter(embedData.footer);
    }
    
    if (embedData.timestamp) {
      embed.setTimestamp();
    }
    
    // Add other properties if present in JSON and supported by EmbedBuilder
    if (embedData.url) embed.setURL(embedData.url);
    if (embedData.image) embed.setImage(embedData.image);
    if (embedData.thumbnail) embed.setThumbnail(embedData.thumbnail);
    if (embedData.author) embed.setAuthor(embedData.author);

    return embed;

  } catch (error) {
    console.error(`Embed error for '${key}':`, error);
    // Return basic error embed
    return new EmbedBuilder()
      .setTitle('Error')
      .setDescription('An error occurred while generating the content.')
      .setColor('#FF0000');
  }
}

// Get buttons by key
function getButtons(key, variables = {}) {
  try {
    // Read and parse the buttons file fresh each time to allow for updates
    const fileContent = fs.readFileSync(BUTTONS_FILE_PATH, 'utf8');
    const buttonsConfig = JSON.parse(fileContent);

    // Navigate the JSON object using the key
    const parts = key.split('.');
    let current = buttonsConfig;
    
    for (const part of parts) {
      if (current[part] === undefined) {
        throw new Error(`Button key '${key}' not found in configuration.`);
      }
      current = current[part];
    }

    // Handle single or array of buttons
    const buttonsData = Array.isArray(current) ? current : [current];
    const buttonBuilders = [];
    
    for (const buttonData of buttonsData) {
      // Deep copy and process variables
      const processedButton = processContent(buttonData, variables);
      
      // Create ButtonBuilder
      const buttonBuilder = new ButtonBuilder();
      
      if (processedButton.customId) {
        buttonBuilder.setCustomId(processedButton.customId);
      }
      
      if (processedButton.label) {
        buttonBuilder.setLabel(processedButton.label);
      }
      
      if (processedButton.style) {
        const style = ButtonStyle[processedButton.style] || ButtonStyle.Secondary;
        buttonBuilder.setStyle(style);
      }
      
      if (processedButton.emoji) {
        buttonBuilder.setEmoji(processedButton.emoji);
      }
      
      // Add URL support for link buttons
      if (processedButton.url) {
        buttonBuilder.setURL(processedButton.url);
      }
      
      // Add disabled state
      if (processedButton.disabled) {
        buttonBuilder.setDisabled(processedButton.disabled);
      }
      
      buttonBuilders.push(buttonBuilder);
    }

    return buttonBuilders;

  } catch (error) {
    console.error(`Buttons error for '${key}':`, error);
    // Return empty array
    return [];
  }
}

// Get action rows with buttons
function getActionRows(key, variables = {}, buttonsPerRow = 5) {
  try {
    const buttons = getButtons(key, variables);
    const actionRows = [];
    
    // Split buttons into rows (max 5 per Discord limit)
    for (let i = 0; i < buttons.length; i += buttonsPerRow) {
      const buttonChunk = buttons.slice(i, i + buttonsPerRow);
      const actionRow = new ActionRowBuilder();
      
      for (const button of buttonChunk) {
        actionRow.addComponents(button);
      }
      
      actionRows.push(actionRow);
    }
    
    return actionRows;

  } catch (error) {
    console.error(`Action rows error for '${key}':`, error);
    // Return empty array
    return [];
  }
}

// Get single button
function getButton(key, variables = {}) {
  try {
    const buttons = getButtons(key, variables);
    return buttons.length > 0 ? buttons[0] : null;
  } catch (error) {
    console.error(`Single button error for '${key}':`, error);
    return null;
  }
}

module.exports = { getEmbed, getButtons, getActionRows, getButton };
