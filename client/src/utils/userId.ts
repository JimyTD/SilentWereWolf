import { v4 as uuidv4 } from 'uuid';

const USER_ID_KEY = 'userId';
const NICKNAME_KEY = 'nickname';

export function getUserId(): string {
  let userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) {
    userId = uuidv4();
    localStorage.setItem(USER_ID_KEY, userId);
  }
  return userId;
}

export function getNickname(): string {
  return localStorage.getItem(NICKNAME_KEY) || '';
}

export function setNickname(nickname: string): void {
  localStorage.setItem(NICKNAME_KEY, nickname);
}
