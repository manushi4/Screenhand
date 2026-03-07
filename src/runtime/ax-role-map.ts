// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.
//
// ScreenHand is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, version 3.
//
// ScreenHand is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with ScreenHand. If not, see <https://www.gnu.org/licenses/>.

/**
 * Maps web ARIA roles to macOS Accessibility roles.
 * Used to translate web-style role targets to native AX queries.
 */
export const WEB_TO_AX_ROLE: Record<string, string> = {
  // Interactive
  button: "AXButton",
  link: "AXLink",
  textbox: "AXTextField",
  checkbox: "AXCheckBox",
  radio: "AXRadioButton",
  combobox: "AXComboBox",
  slider: "AXSlider",
  switch: "AXCheckBox",
  tab: "AXRadioButton",
  menuitem: "AXMenuItem",
  menu: "AXMenu",
  menubar: "AXMenuBar",
  option: "AXMenuItem",
  listbox: "AXList",
  spinbutton: "AXIncrementor",
  scrollbar: "AXScrollBar",

  // Structure
  heading: "AXHeading",
  list: "AXList",
  listitem: "AXGroup",
  table: "AXTable",
  row: "AXRow",
  cell: "AXCell",
  grid: "AXTable",
  treegrid: "AXOutline",
  tree: "AXOutline",
  treeitem: "AXOutlineRow",
  toolbar: "AXToolbar",
  tablist: "AXTabGroup",
  tabpanel: "AXGroup",
  group: "AXGroup",
  region: "AXGroup",
  dialog: "AXSheet",
  alertdialog: "AXSheet",

  // Semantic
  img: "AXImage",
  image: "AXImage",
  progressbar: "AXProgressIndicator",
  separator: "AXSplitter",
  status: "AXStaticText",
  tooltip: "AXHelpTag",
  banner: "AXGroup",
  navigation: "AXGroup",
  main: "AXGroup",
  contentinfo: "AXGroup",
  complementary: "AXGroup",
  article: "AXGroup",
  document: "AXGroup",

  // Text
  statictext: "AXStaticText",
  textarea: "AXTextArea",
  text: "AXStaticText",

  // Window-level
  window: "AXWindow",
  application: "AXApplication",
};

/**
 * Maps macOS AX roles back to web ARIA roles.
 */
export const AX_TO_WEB_ROLE: Record<string, string> = {};
for (const [web, ax] of Object.entries(WEB_TO_AX_ROLE)) {
  if (!(ax in AX_TO_WEB_ROLE)) {
    AX_TO_WEB_ROLE[ax] = web;
  }
}

/**
 * Convert a web-style role to macOS AX role.
 * If already an AX role (starts with "AX"), pass through.
 */
export function toAXRole(role: string): string {
  if (role.startsWith("AX")) return role;
  return WEB_TO_AX_ROLE[role.toLowerCase()] ?? role;
}
