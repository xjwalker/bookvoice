import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StoreProvider, useTheme } from '../src/store/AppStore';
import { initMediaSession } from '../src/services/mediaSession';

function ThemedStack() {
  const theme = useTheme();
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
