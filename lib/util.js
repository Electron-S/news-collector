'use strict';

const clip = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max).trim()}…` : t;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { clip, sleep };
