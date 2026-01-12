import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';

import { PanelWebViewScreen } from '../screens/PanelWebViewScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { useSession } from '../session/SessionContext';
import { colors } from '../theme/colors';
import type { MainTabParamList } from './types';

const Tabs = createBottomTabNavigator<MainTabParamList>();
const RootStack = createNativeStackNavigator<{ Auth: undefined; Main: undefined }>();

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
      <Tabs.Screen name="PanelTab" component={PanelWebViewScreen} options={{ title: 'Panel', headerShown: false }} />
      <Tabs.Screen name="PhoneTab" component={SettingsScreen} options={{ title: 'Telefon' }} />
    </Tabs.Navigator>
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
