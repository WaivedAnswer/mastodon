import { createRestAPIClient } from "masto";
import { convert } from 'html-to-text';
import OpenAI from "openai";

const masto = createRestAPIClient({
    url: 'https://botsin.space/api/v1/',
    accessToken: process.env.MASTODON_ACCESS_TOKEN,
  });

function isReadonly() {
    return process.env.READ_ONLY !== undefined ? process.env.READ_ONLY === "true" : true
}

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

async function passesModeration(lookingFor) {
    let input = lookingFor
    const moderation = await openai.moderations.create({ input: input });
    if(moderation.results.length !==0 && moderation.results[0].flagged) {
        console.log("Failed moderation")
        return false
    } 
    return true
}

const options = {
    wordwrap: 130,
    // ...
  };

async function getReply(userName, lookingFor) {
    const hasPassed = await passesModeration(lookingFor)

    if(!hasPassed) {
        return `@${userName} Sorry I can't help you with that request`
    }
    const functionName = "display_book_recommendation";
    const STRING_TYPE = "string";
    const OBJECT_TYPE = "object"
    const ARRAY_TYPE = "array"
    const functions = [ {
        name: functionName,
        description: "Displays book recommendation",
        parameters: {
            type: OBJECT_TYPE,
            properties: {
                results: {
                    type: ARRAY_TYPE,
                    items: {
                        type: OBJECT_TYPE,
                        properties: {
                            title: {
                                type: STRING_TYPE,
                                description: "Book Title"
                            },
                            author: {
                                type: STRING_TYPE,
                                description: "Book Author"
                            },
                            reason: {
                                type: STRING_TYPE,
                                description: "Sales pitch to the user on why they will love the book. Limit to 20 words"
                            } 
                        },
                        required: ["title", 
                            "author", 
                            "reason"
                            ]
                    },
                }
            }
        }
    }]

    const chatResponse = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        messages: [
            {role: "system", "content": "Act as an expert librarian, tailoring book recommendations to user preferences without spoilers. Really focus on understanding and matching the user's reading tastes, and ensure suggestions are personalized and engaging. Limit to top two responses, or less if there aren't good enough options."},
            {role: "user", "content": "The user's search was: " + lookingFor},
        ],
        functions: functions,
        function_call: {name: functionName}
    });

    const bookRecommendationCall = chatResponse.choices[0].message.function_call
    if(!bookRecommendationCall || bookRecommendationCall.name !== functionName) {
        throw new Error("Failed to retrieve recommendation")
    }

    const recommendation = JSON.parse(bookRecommendationCall.arguments)
    const results = recommendation.results
    let recommendationString = ""
    for(const result of results) {
        recommendationString += `\n${result.title}\n${result.author}\n${result.reason}\n`
    }
    if(recommendationString === "") {
        return `@${userName} Sorry I can't find any books for that search, you can still find more #books @ https://findmyread.com `
    }
    
    return `@${userName} ${recommendationString}\nFind more #books @ https://findmyread.com`
}

async function toot(message, originStatusId) {
    if(isReadonly()) {
        return
    }
    await masto.v1.statuses.create({
        inReplyToId: originStatusId,
        status: message,
        visibility: "public",
    });
}

async function dismissAllNotifications() {
    if(isReadonly()) {
        return
    }
    await masto.v1.notifications.clear()
}

async function replyToUsers() {
    try {
        const notifications = await masto.v1.notifications.list({types: ["mention"]});
        console.log(`Processing ${notifications.length} notifications`)
        for(const notification of notifications) {
            if(notification.type !== "mention") {
                continue
            }
            const userName = notification.account.acct
            try {
                const content = notification.status.content
                const plainTextContent = convert(content, options);
                console.log("Query:", plainTextContent)
                const id = notification.status.id
                const message = await getReply(userName, plainTextContent)
                await toot(message, id)
                console.log("Response:", message)
            } catch (error) {
                console.error("Failed reply:", userName, error)
            }
        }
        if(notifications.length !== 0) {
            await dismissAllNotifications()
        }
    }
    catch (error) {
        console.error("Failed global:", error);
    }
}

export const handler = async (event, context, callback) => {
    await replyToUsers();
    callback(null, 'Finished') 
};