import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StoreProvider, useTheme, useStore } from '../src/store/AppStore';
import { initMediaSession } from '../src/services/mediaSession';

SplashScreen.preventAutoHideAsync();

function ThemedStack() {
  const theme = useTheme();
  const { state } = useStore();

  useEffect(() => {
    if (state.isLoaded) {
      SplashScreen.hideAsync();
    }
  }, [state.isLoaded]);

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg }, animation: 'slide_from_right' }} />
  );
}

export default function RootLayout() {
  useEffect(() => {
    initMediaSession();
  }, []);

  return (
    <StoreProvider>
      <ThemedStack />
    </StoreProvider>
  );
}
