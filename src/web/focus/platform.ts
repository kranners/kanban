const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);

export const commandKey = apple ? "⌘" : "Ctrl+";

export const optionKey = apple ? "Option" : "Alt";
