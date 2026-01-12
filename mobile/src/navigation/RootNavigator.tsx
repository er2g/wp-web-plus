import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { PanelWebViewScreen } from '../screens/PanelWebViewScreen';
import { PhoneWebViewScreen } from '../screens/PhoneWebViewScreen';
import { colors } from '../theme/colors';
import type { MainTabParamList } from './types';

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

export function RootNavigator() {
  return (
    <NavigationContainer theme={navTheme}>
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
        <Tabs.Screen name="PanelTab" component={PanelWebViewScreen} options={{ title: 'Panel' }} />
        <Tabs.Screen name="PhoneTab" component={PhoneWebViewScreen} options={{ title: 'Telefon' }} />
      </Tabs.Navigator>
    </NavigationContainer>
  );
}

