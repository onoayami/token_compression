export const stripBOM = text => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
