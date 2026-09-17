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
  onEvent: (eventType: string, callback: (data?: { data?: string }) => void) => void;
  offEvent: (eventType: string, callback: (data?: { data?: string }) => void) => void;
  disableVerticalSwipes: () => void;
  enableClosingConfirmation: () => void;
  disableClosingConfirmation?: () => void;
  showScanQrPopup?: (options: { text?: string }) => void;
  closeScanQrPopup?: () => void;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  };
}

interface Window {
  Telegram?: { WebApp: TelegramWebApp };
}
