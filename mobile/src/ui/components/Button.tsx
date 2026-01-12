import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../../theme/colors';

export function Button(props: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const variant = props.variant || 'primary';
  const stylesForVariant =
    variant === 'primary' ? styles.primary : variant === 'danger' ? styles.danger : styles.ghost;

  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled || props.loading}
      style={[styles.base, stylesForVariant, (props.disabled || props.loading) && styles.disabled]}
    >
      {props.loading ? <ActivityIndicator color={colors.text} /> : <Text style={styles.text}>{props.title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.primary },
  danger: { backgroundColor: colors.danger },
  ghost: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  disabled: { opacity: 0.6 },
  text: { color: colors.text, fontSize: 15, fontWeight: '700' },
});

