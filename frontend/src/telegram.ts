type TelegramWebApp = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData?.trim() ?? '';
}

export function prepareTelegramWebApp() {
  const webApp = window.Telegram?.WebApp;
  webApp?.ready?.();
  webApp?.expand?.();
}

export function hasTelegramWebApp() {
  return Boolean(window.Telegram?.WebApp);
}