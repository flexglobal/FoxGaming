'use strict';
/* Ники, которыми нельзя представляться (бот Mono, администрация, поддержка). Такие ники сервер заменяет нейтральным. */
const RESERVED=/^(mono|моно)([\s._-]*(bot|бот|official|офиц\S*|support|поддержка|team|команда|admin\S*|админ\S*))?$|^(admin\S*|админ\S*|администрация|moderator|модератор\S*|support|поддержка)$/i;
const normalize=n=>String(n||'').normalize('NFKC').replace(/[​-‏⁠﻿]/g,'').trim();
const reserved=n=>typeof n==='string'&&RESERVED.test(normalize(n));
const safeNick=(n,fallback='Пользователь Mono')=>reserved(n)?fallback:n;
module.exports={reserved,safeNick};
