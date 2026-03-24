import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StoreProvider } from '../src/store/AppStore';
import { initMediaSession } from '../src/services/mediaSession';

export default function RootLayout() {
  useEffect(() => {
    initMediaSession();
  }, []);

  return (
    <StoreProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0a0a0f' }, animation: 'slide_from_right' }} />
    </StoreProvider>
  );
}
