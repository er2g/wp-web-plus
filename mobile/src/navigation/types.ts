export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};

export type AuthStackParamList = {
  Login: undefined;
};

export type MainTabParamList = {
  ChatsTab: undefined;
  SettingsTab: undefined;
};

export type ChatsStackParamList = {
  Chats: undefined;
  Chat: { chatId: string; title?: string | null };
};

export type SettingsStackParamList = {
  Settings: undefined;
};

