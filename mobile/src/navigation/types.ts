export type MainTabParamList = {
  ChatsTab: undefined;
  ToolsTab: undefined;
  PhoneTab: undefined;
};

// Legacy (kept to avoid breaking existing screen typings)
export type ChatsStackParamList = {
  Chats: undefined;
  Chat: { chatId: string; title?: string | null };
};
