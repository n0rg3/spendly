interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: TelegramWebAppUser };
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  viewportHeight: number;
  viewportStableHeight: number;
  onEvent: (eventType: string, callback: () => void) => void;
  offEvent: (eventType: string, callback: () => void) => void;
  disableVerticalSwipes: () => void;
}

interface Window {
  Telegram?: { WebApp: TelegramWebApp };
}
