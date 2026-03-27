import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as TTS from '../services/tts';
import { UserSettings } from '../types';
import { Theme, THEME_OPTIONS } from '../theme';

const ACCENT_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#e67e22', '#f39c12', '#1abc9c', '#e74c3c'];
const TEXT_SIZES = [14, 16, 18, 20, 22, 24];

interface Props {
  visible: boolean;
  settings: UserSettings;
  theme: Theme;
  bookLanguage?: string;
  onUpdate: (partial: Partial<UserSettings>) => void;
  onClose: () => void;
}

export default function SettingsModal({ visible, settings, theme, bookLanguage, onUpdate, onClose }: Props) {
  const [voices, setVoices] = useState<any[]>([]);
  const [showVoices, setShowVoices] = useState(false);

  useEffect(() => {
    if (visible) {
      TTS.getVoices().then((v) => {
        const lang = bookLanguage?.slice(0, 2) ?? '';
        const filtered = lang ? v.filter((voice: any) => voice.language?.startsWith(lang)) : v;
        const list = filtered.length > 0 ? filtered : v;
        list.sort((a: any, b: any) => (b.quality ?? 0) - (a.quality ?? 0));
        setVoices(list);
      });
    }
  }, [visible, bookLanguage]);

  if (!visible) return null;

  const accent = settings.accentColor;
  const s = makeStyles(theme);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={onClose}>
        <View style={s.sheet} onStartShouldSetResponder={() => true}>
          <View style={s.handle} />
          <Text style={s.title}>Settings</Text>

          {/* Voice */}
          <Text style={s.label}>Voice</Text>
          <Text style={s.hint}>
            For better voices: Settings → Accessibility → Spoken Content → Voices → download Enhanced/Premium
          </Text>
          <TouchableOpacity style={s.voiceBtn} onPress={() => setShowVoices(!showVoices)} accessibilityRole="button" accessibilityLabel={`Voice: ${settings.voiceId ? voices.find((v: any) => v.identifier === settings.voiceId)?.name ?? settings.voiceId : 'System Default'}. Double tap to change`}>
            <Ionicons name="mic-outline" size={18} color={theme.textPrimary} />
            <Text style={s.voiceBtnText} numberOfLines={1}>
              {settings.voiceId
                ? voices.find((v: any) => v.identifier === settings.voiceId)?.name ?? settings.voiceId
                : 'System Default'}
            </Text>
            <Ionicons name={showVoices ? 'chevron-up' : 'chevron-down'} size={16} color={theme.textDim} />
          </TouchableOpacity>
          {showVoices && (
            <ScrollView style={s.voiceList}>
              <TouchableOpacity
                style={[s.voiceItem, !settings.voiceId && s.voiceItemActive]}
                onPress={() => { onUpdate({ voiceId: undefined }); setShowVoices(false); }}>
                <Text style={[s.voiceItemText, !settings.voiceId && { color: accent }]}>
                  System Default
                </Text>
              </TouchableOpacity>
              {voices.map((v: any) => {
                const qualityLabel = v.quality >= 2 ? 'Premium' : v.quality >= 1 ? 'Enhanced' : 'Basic';
                const qualityColor = v.quality >= 2 ? '#27ae60' : v.quality >= 1 ? '#2980b9' : theme.textDim;
                const isSelected = settings.voiceId === v.identifier;
                return (
                  <TouchableOpacity
                    key={v.identifier}
                    style={[s.voiceItem, isSelected && s.voiceItemActive]}
                    onPress={() => { onUpdate({ voiceId: v.identifier }); setShowVoices(false); }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.voiceItemText, isSelected && { color: accent }]}>
                        {v.name}
                      </Text>
                      <Text style={s.voiceItemLang}>{v.language}</Text>
                    </View>
                    <View style={[s.qualityBadge, { borderColor: qualityColor }]}>
                      <Text style={[s.qualityText, { color: qualityColor }]}>{qualityLabel}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* Text Size */}
          <Text style={s.label}>Text Size</Text>
          <View style={s.sizeRow}>
            {TEXT_SIZES.map(sz => (
              <TouchableOpacity
                key={sz}
                style={[s.sizeBtn, settings.textSize === sz && { backgroundColor: accent }]}
                onPress={() => onUpdate({ textSize: sz })}
                accessibilityRole="button"
                accessibilityLabel={`Text size ${sz}`}
                accessibilityState={{ selected: settings.textSize === sz }}
              >
                <Text style={[s.sizeBtnText, settings.textSize === sz && { color: '#fff' }]}>{sz}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Accent Color */}
          <Text style={s.label}>Accent Color</Text>
          <View style={s.colorRow}>
            {ACCENT_COLORS.map((c, i) => {
              const colorNames = ['Red', 'Blue', 'Green', 'Purple', 'Orange', 'Yellow', 'Teal', 'Coral'];
              return (
                <TouchableOpacity
                  key={c}
                  style={[s.colorBtn, { backgroundColor: c }, accent === c && s.colorBtnActive]}
                  onPress={() => onUpdate({ accentColor: c })}
                  accessibilityRole="button"
                  accessibilityLabel={`${colorNames[i] || 'Color'} accent`}
                  accessibilityState={{ selected: accent === c }}
                />
              );
            })}
          </View>

          {/* App Theme */}
          <Text style={s.label}>App Theme</Text>
          <View style={s.themeRow}>
            {THEME_OPTIONS.map(t => (
              <TouchableOpacity
                key={t.key}
                style={[s.themeBtn, {
                  backgroundColor: t.key === 'dark' ? '#0a0a0f' : t.key === 'dim' ? '#1a1a24' : t.key === 'light' ? '#f5f0e8' : '#fdf6e3',
                  borderColor: settings.appTheme === t.key ? accent : theme.border,
                }]}
                onPress={() => onUpdate({ appTheme: t.key })}
                accessibilityRole="button"
                accessibilityLabel={`${t.label} theme`}
                accessibilityState={{ selected: settings.appTheme === t.key }}
              >
                <Text style={[s.themeBtnText, {
                  color: (t.key === 'light' || t.key === 'sepia') ? '#3c3c3c' : '#d4ccbc',
                }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* About */}
          <Text style={s.label}>About</Text>
          <View style={s.aboutSection}>
            <Text style={s.aboutName}>ReadItForMe v1.0.0</Text>
            <Text style={s.aboutDesc}>Turn your PDFs into audiobooks</Text>
            <View style={s.aboutLinks}>
              <TouchableOpacity onPress={() => Linking.openURL('https://github.com/xjwalker')} style={s.aboutLink}>
                <Ionicons name="logo-github" size={16} color={theme.textSecondary} />
                <Text style={[s.aboutLinkText, { color: theme.textSecondary }]}>xjwalker</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Linking.openURL('mailto:reachjwalker@gmail.com')} style={s.aboutLink}>
                <Ionicons name="mail-outline" size={16} color={theme.textSecondary} />
                <Text style={[s.aboutLinkText, { color: theme.textSecondary }]}>reachjwalker@gmail.com</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: t.overlay, justifyContent: 'flex-end' },
    sheet: { backgroundColor: t.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40, maxHeight: '80%' },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: t.border, alignSelf: 'center', marginBottom: 16 },
    title: { fontSize: 18, fontWeight: '700', color: t.textPrimary, textAlign: 'center', marginBottom: 20 },
    label: { fontSize: 13, fontWeight: '600', color: t.textSecondary, marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
    hint: { fontSize: 11, color: t.textDim, marginBottom: 8, lineHeight: 16 },
    voiceBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surfaceDeep, borderRadius: 10, padding: 14 },
    voiceBtnText: { flex: 1, fontSize: 15, color: t.textPrimary },
    voiceList: { maxHeight: 200, backgroundColor: t.surfaceDeep, borderRadius: 10, marginTop: 8 },
    voiceItem: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: t.surface, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    voiceItemActive: { backgroundColor: t.surface },
    voiceItemText: { fontSize: 14, color: t.textSecondary },
    voiceItemLang: { fontSize: 11, color: t.textDim, marginTop: 1 },
    qualityBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
    qualityText: { fontSize: 10, fontWeight: '600' },
    sizeRow: { flexDirection: 'row', gap: 8 },
    sizeBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: t.surfaceDeep, alignItems: 'center' },
    sizeBtnText: { fontSize: 14, fontWeight: '600', color: t.textDim },
    colorRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
    colorBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: 'transparent' },
    colorBtnActive: { borderColor: '#fff', borderWidth: 3 },
    themeRow: { flexDirection: 'row', gap: 8 },
    themeBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, borderWidth: 2, alignItems: 'center' },
    themeBtnText: { fontSize: 12, fontWeight: '600' },
    aboutSection: { backgroundColor: t.surfaceDeep, borderRadius: 10, padding: 16 },
    aboutName: { fontSize: 15, fontWeight: '700', color: t.textPrimary },
    aboutDesc: { fontSize: 12, color: t.textDim, marginTop: 2 },
    aboutLinks: { marginTop: 12, gap: 8 },
    aboutLink: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    aboutLinkText: { fontSize: 13 },
  });
}
