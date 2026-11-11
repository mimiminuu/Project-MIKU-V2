import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../config.js';

const ACCOUNTS_FILE = path.join(STORE_DIR, 'accounts.json');

const DEFAULT_ACCOUNTS = [
  {
    id: 'admin',
    password: '1212',
    name: '관리자',
    role: 'admin',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'guest',
    password: 'demo',
    name: '',
    role: 'demo',
    createdAt: new Date().toISOString(),
  },
];

class AccountManager {
  constructor() {
    this.accounts = [];
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(STORE_DIR)) {
        fs.mkdirSync(STORE_DIR, { recursive: true });
      }

      if (fs.existsSync(ACCOUNTS_FILE)) {
        const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.accounts = parsed;
          // admin 계정이 없거나 비밀번호가 1212가 아니면 보정
          const adminIdx = this.accounts.findIndex((a) => a.id === 'admin');
          if (adminIdx === -1) {
            this.accounts.unshift(DEFAULT_ACCOUNTS[0]);
            this.save();
          } else if (this.accounts[adminIdx].password !== '1212') {
            this.accounts[adminIdx].password = '1212';
            this.save();
          }
          return;
        }
      }

      // 파일이 없거나 비어있는 경우 기본값 저장
      this.accounts = [...DEFAULT_ACCOUNTS];
      this.save();
    } catch (err) {
      console.error('[AccountManager] 계정 로딩 실패, 기본 계정 적용:', err.message);
      this.accounts = [...DEFAULT_ACCOUNTS];
    }
  }

  save() {
    try {
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(this.accounts, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AccountManager] 계정 저장 실패:', err.message);
    }
  }

  getAccounts() {
    return this.accounts.map(({ id, password, name, role, createdAt }) => ({
      id,
      password,
      name: name || id,
      role: role || 'user',
      createdAt: createdAt || new Date().toISOString(),
    }));
  }

  verifyAccount(id, password) {
    const cleanId = (id || '').trim();
    const cleanPw = (password || '').trim();
    if (!cleanId || !cleanPw) return null;

    const matched = this.accounts.find(
      (acc) => acc.id.toLowerCase() === cleanId.toLowerCase() && String(acc.password) === cleanPw
    );

    if (!matched) return null;
    return {
      id: matched.id,
      name: matched.name || matched.id,
      role: matched.role || 'user',
    };
  }

  addAccount({ id, password, name, role = 'user' }) {
    const cleanId = (id || '').trim();
    const cleanPw = (password || '').trim();
    const cleanName = (name || '').trim();

    if (!cleanId || !cleanPw) {
      throw new Error('아이디와 비밀번호를 모두 입력해 주세요.');
    }

    if (this.accounts.some((a) => a.id.toLowerCase() === cleanId.toLowerCase())) {
      throw new Error('이미 등록된 계정 아이디입니다.');
    }

    const assignedRole = role === 'admin' ? 'admin' : role === 'demo' ? 'demo' : 'user';

    const newAccount = {
      id: cleanId,
      password: cleanPw,
      name: cleanName || (assignedRole === 'demo' ? '' : cleanId),
      role: assignedRole,
      createdAt: new Date().toISOString(),
    };

    this.accounts.push(newAccount);
    this.save();
    return newAccount;
  }

  deleteAccount(id) {
    const cleanId = (id || '').trim();
    if (cleanId.toLowerCase() === 'admin') {
      throw new Error('기본 관리자 계정(admin)은 삭제할 수 없습니다.');
    }

    const prevLen = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id.toLowerCase() !== cleanId.toLowerCase());
    if (this.accounts.length === prevLen) {
      throw new Error('삭제할 계정을 찾을 수 없습니다.');
    }

    this.save();
    return true;
  }
}

export const accountManager = new AccountManager();
