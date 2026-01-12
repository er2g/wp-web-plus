import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useSession } from '../session/SessionContext';
import { colors } from '../theme/colors';
import { ChatScreen } from '../screens/ChatScreen';
import { ChatsScreen } from '../screens/ChatsScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import type { AuthStackParamList, ChatsStackParamList, MainTabParamList, RootStackParamList, SettingsStackParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const ChatsStack = createNativeStackNavigator<ChatsStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.card,
    border: colors.border,
    text: colors.text,
    primary: colors.primary,
  },
};

function AuthNavigator() {
  return (
    <AuthStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <AuthStack.Screen name="Login" component={LoginScreen} options={{ title: 'Giriş' }} />
    </AuthStack.Navigator>
  );
}

function ChatsNavigator() {
  return (
    <ChatsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <ChatsStack.Screen name="Chats" component={ChatsScreen} options={{ title: 'Sohbetler' }} />
      <ChatsStack.Screen
        name="Chat"
        component={ChatScreen}
        options={({ route }) => ({ title: route.params.title || route.params.chatId })}
      />
    </ChatsStack.Navigator>
  );
}

function SettingsNavigator() {
  return (
    <SettingsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <SettingsStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Ayarlar' }} />
    </SettingsStack.Navigator>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.subtext,
      }}
    >
      <Tabs.Screen name="ChatsTab" component={ChatsNavigator} options={{ title: 'Sohbetler' }} />
      <Tabs.Screen name="SettingsTab" component={SettingsNavigator} options={{ title: 'Ayarlar' }} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const session = useSession();

  return (
    <NavigationContainer theme={navTheme}>
      <RootStack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        {session.status === 'signedIn' ? (
          <RootStack.Screen name="Main" component={MainTabs} />
        ) : (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
