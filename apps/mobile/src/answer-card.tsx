import { Text, View } from "react-native";
import { BubbleChatQuestionIcon } from "@hugeicons/core-free-icons";
import type { AnsweredQuestion } from "@milagre/shared/model";
import { Icon } from "./icons";
import { lineHeight, radius, type } from "./design-tokens";
import { useTheme } from "./theme";

/** The user's answers to the agent's questions, shown as each question with what was picked or typed instead of the text the agent reads. */
export function AnswerCard({ answered }: { answered: AnsweredQuestion[] }) {
  const { colors } = useTheme();
  const title = answered.length === 1 ? "Answered the question" : `Answered ${answered.length} questions`;
  return (
    <View
      accessibilityLabel={title}
      style={{
        minWidth: 240,
        borderRadius: radius.sheet,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.surface,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 16,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderColor: colors.line,
        }}
      >
        <Icon icon={BubbleChatQuestionIcon} tone="ink2" size={12} />
        <Text style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>{title}</Text>
      </View>
      {answered.map((item, index) => (
        <View key={index} style={{ gap: 2, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: index ? 1 : 0, borderColor: colors.line }}>
          <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{item.question}</Text>
          <Text selectable style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>
            {item.answers.join(", ")}
          </Text>
        </View>
      ))}
    </View>
  );
}
