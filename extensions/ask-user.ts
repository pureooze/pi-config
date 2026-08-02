import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OTHER_OPTION = "Other (enter your own answer)";
const DONE_OPTION = "Done selecting";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask the user a question and wait for their response.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user" }),
      options: Type.Array(Type.String(), {
        description: "The choices to show in the selection menu",
      }),
      multiple: Type.Optional(
        Type.Boolean({ description: "Allow the user to select multiple choices" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Interactive UI is unavailable in this mode." }],
          isError: true,
        };
      }

      if (params.options.length === 0) {
        return {
          content: [{ type: "text", text: "No options were provided." }],
          isError: true,
        };
      }

      const options = params.options.includes(OTHER_OPTION)
        ? params.options
        : [...params.options, OTHER_OPTION];

      if (!params.multiple) {
        const selected = await ctx.ui.select(params.question, options);
        const answer = selected === OTHER_OPTION
          ? await ctx.ui.input("Enter your answer:", "")
          : selected;

        return {
          content: [{ type: "text", text: answer ?? "The user cancelled the question." }],
          details: {
            question: params.question,
            options,
            selected: selected ?? null,
            answer: answer ?? null,
          },
        };
      }

      const answers: string[] = [];
      let remaining = [...options];
      let cancelled = false;

      while (remaining.length > 0) {
        const selected = await ctx.ui.select(
          answers.length === 0
            ? params.question
            : `${params.question} (${answers.length} selected)`,
          [...remaining, DONE_OPTION],
        );

        if (selected === undefined) {
          cancelled = true;
          break;
        }
        if (selected === DONE_OPTION) break;

        if (selected === OTHER_OPTION) {
          const customAnswer = await ctx.ui.input("Enter your answer:", "");
          if (customAnswer === undefined) {
            cancelled = true;
            break;
          }
          if (customAnswer.trim()) answers.push(customAnswer.trim());
        } else {
          answers.push(selected);
        }

        remaining = remaining.filter((option) => option !== selected);
      }

      return {
        content: [{
          type: "text",
          text: cancelled && answers.length === 0
            ? "The user cancelled the question."
            : JSON.stringify(answers),
        }],
        details: {
          question: params.question,
          options,
          multiple: true,
          answers,
          cancelled,
        },
      };
    },
  });
}
