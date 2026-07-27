/**
 * Makes the active theme available to chrome components without threading it
 * through every layer of props.
 */

import React, { createContext, useContext } from 'react';
import { DEFAULT_THEME, type Theme } from './themes.js';

const ThemeContext = createContext<Theme>(DEFAULT_THEME);

export function ThemeProvider({
  theme,
  children,
}: {
  theme: Theme;
  children: React.ReactNode;
}): React.ReactElement {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
