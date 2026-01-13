import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';

import { ChatScreen } from '../screens/ChatScreen';
import { ChatsScreen } from '../screens/ChatsScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ToolsScreen } from '../screens/ToolsScreen';
import { useSession } from '../session/SessionContext';
import { colors } from '../theme/colors';
import type { ChatsStackParamList, MainTabParamList } from './types';

const Tabs = createBottomTabNavigator<MainTabParamList>();
const RootStack = createNativeStackNavigator<{ Auth: undefined; Main: undefined }>();
const ChatsStack = createNativeStackNavigator<ChatsStackParamList>();

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

function TabsNavigator() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.subtext,
      }}
    >
      <Tabs.Screen name="ChatsTab" component={ChatsStackNavigator} options={{ title: 'Sohbetler', headerShown: false }} />
      <Tabs.Screen name="ToolsTab" component={ToolsScreen} options={{ title: 'Araçlar' }} />
      <Tabs.Screen name="PhoneTab" component={SettingsScreen} options={{ title: 'Telefon' }} />
    </Tabs.Navigator>
  );
}

function ChatsStackNavigator() {
  return (
    <ChatsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <ChatsStack.Screen name="Chats" component={ChatsScreen} options={{ title: 'WhatsApp' }} />
      <ChatsStack.Screen
        name="Chat"
        component={ChatScreen}
        options={({ route }) => ({ title: route.params?.title || 'Sohbet' })}
      />
    </ChatsStack.Navigator>
  );
}

export function RootNavigator() {
  const session = useSession();

  return (
    <NavigationContainer theme={navTheme}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {session.status === 'loading' ? (
          <RootStack.Screen
            name="Auth"
            component={() => (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
                <ActivityIndicator color={colors.primary} />
              </View>
            )}
          />
        ) : session.status === 'signedIn' ? (
          <RootStack.Screen name="Main" component={TabsNavigator} />
        ) : (
          <RootStack.Screen name="Auth" component={LoginScreen} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
