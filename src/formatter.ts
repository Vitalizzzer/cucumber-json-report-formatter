/* eslint-disable @typescript-eslint/no-explicit-any */
import { Helper } from './helper'
import jsonschema from 'jsonschema'
import assert from 'assert'


export class Formatter {

    helper = new Helper()

    public async parseCucumberJson(sourceFile: string, outputFile: string) {
        console.info(`Start formatting file '${sourceFile}' into '${outputFile}'`)
        const report = await this.helper.readFileIntoJson(sourceFile)
        const gherkinDocumentJson = this.helper.getJsonFromArray(report, "gherkinDocument")
        const cucumberReport: any [] = []

        gherkinDocumentJson.forEach(gherkinJson => {
            let gherkinDocument: any
            try{
                gherkinDocument = JSON.parse(gherkinJson).gherkinDocument
            } catch (err) {
                console.error("Error parsing JSON string.", err)
            }
            const feature = gherkinDocument.feature
            const featureChildren = feature.children
            const scenariosJson: any [] = []
            const background = {}
            featureChildren.forEach(featureChild => {
                if (featureChild.rule) {
                    featureChild.rule.steps = [];
                    featureChild.rule.children.forEach(ruleChildren => {
                        this.buildAndAddScenario(ruleChildren, report, background, feature, scenariosJson, featureChild.rule);
                    });
                } else {
                    this.buildAndAddScenario(featureChild, report, background, feature, scenariosJson, undefined);
                }
            });

            const rootJson = {
                comments: this.getComments(gherkinDocument.comments),
                description: gherkinDocument.feature.description,
                elements: scenariosJson,
                id: feature.name,
                keyword: feature.keyword,
                line: feature.location.line,
                name: feature.name,
                uri: gherkinDocument.uri,
                tags: this.getTags(gherkinDocument.feature.tags)
            }

            cucumberReport.push(rootJson)
        })

        await this.validateReportSchema(report)
        const reportString = JSON.stringify(cucumberReport)
        console.info(`Finished formatting file '${sourceFile}'`)
        this.helper.writeFile(outputFile, reportString)
    }

    private buildAndAddScenario(child, report: string[], background: {}, feature, scenariosJson: any[], rule) {
        let steps = [];
        let stepJson = {};
        // Background
        if (child.scenario === undefined) {
            child.background.steps.forEach(step => {
                stepJson = this.createStepJson(step, report, 0);
                // @ts-ignore
                steps.push(stepJson);
            });
            background = this.createScenarioJson(feature, child.background, steps, "background");
            // eslint-disable-next-line brace-style
        }
        // Normal Scenario
        else if (!child.scenario.keyword.includes("Outline")) {
            child.scenario.steps.forEach(step => {
                stepJson = this.createStepJson(step, report, 0);
                // @ts-ignore
                steps.push(stepJson);
            });
            const scenario = this.createScenarioJson(feature, child.scenario, steps, "scenario");
            if (rule) {
                scenario.id = `${feature.name};${rule.name};${scenario.name}`;
            }
            if (Object.keys(background).length !== 0 && background !== undefined) {
                // @ts-ignore
                scenariosJson.push(background);
            }
            // @ts-ignore
            scenariosJson.push(scenario);
        }
        // Scenario Outline
        else if (child.scenario.examples[0].tableBody !== undefined) {
            const numberOfExecutions = child.scenario.examples[0].tableBody.length;
            const numberOfStepsEachExecution = child.scenario.steps.length;
            let scenarioIndex = 0;
            while (scenarioIndex < numberOfExecutions) {
                let currentStep = 0;
                steps = [];
                while (currentStep < numberOfStepsEachExecution) {
                    stepJson = this.createStepJson(child.scenario.steps[currentStep], report, scenarioIndex);
                    currentStep++;
                    // @ts-ignore
                    steps.push(stepJson);
                }
                const scenario = this.createScenarioJson(feature, child.scenario, steps, "scenario", scenarioIndex);
                if (rule) {
                    scenario.id = `${feature.name};${rule.name};${scenario.name}`;
                }
                if (Object.keys(background).length !== 0 && background !== undefined) {
                    // @ts-ignore
                    scenariosJson.push(background);
                }
                // @ts-ignore
                scenariosJson.push(scenario);
                scenarioIndex++;
            }
        }
    }

    createStepJson(step, report, ignorePickles)
    {
        const text = this.getStepText(step.id, report, ignorePickles)
        const result = this.getStepResult(step.id, report, ignorePickles)
        const attachments = this.getStepAttachments(step.id, report, ignorePickles)
        const match = this.matchStepDefinitions(step.id, report, ignorePickles)
        const json = {
            keyword: step.keyword,
            line: step.location.line,
            name: text,
            result: result,
            embeddings: attachments,
            match: match
        }
        return json
    }

    createScenarioJson(feature, scenario, steps, scenarioType, scenarioIndex?)
    {
        let scenarioName = scenario.name
        if (scenarioIndex !== undefined && scenarioName.includes('<') && scenarioName.includes('>')) {
            const examples: any[] = []
            const headerCells = scenario.examples[0].tableHeader.cells
            const bodyCells = scenario.examples[0].tableBody[scenarioIndex].cells
            for (let i = 0; i < headerCells.length; i++) {
                const k = headerCells[i].value
                const v = bodyCells[i].value
                examples.push({header: k, value: v})
            }
            examples.forEach(example => {
                scenarioName = scenarioName.replace(`<${example.header}>`, example.value)
            })
        }
        const json = {
            description: scenario.description,
            id: `${feature.name};${scenarioName}`,
            keyword: scenario.keyword,
            line: scenario.location.line,
            name: scenarioName,
            steps: steps,
            tags: this.getTags(scenario.tags),
            type: scenarioType
        }
        return json
    }

    getStepText(stepId, report, ignoreAmount){
        if (typeof report === undefined) {
            console.error("Source report is undefined")
            return
        }
        const pickleJson = this.helper.getJsonFromArray(report, "pickle")
        const pickleStepId = this.getPickleStepIdByStepId(pickleJson, stepId, ignoreAmount)
        const text = this.getPickleText(pickleStepId, pickleJson)
        return text
    }
    getPickleText(pickleStepId, pickleJson)
    {
        let output
        pickleJson.forEach(json => {
            const parsed = JSON.parse(json)
            parsed.pickle.steps.forEach(step => {
                if(step.id == pickleStepId)
                    output = step.text
            })
        })
        return output
    }


    getStepResult(stepId, report, ignoreAmount){
        if (typeof report === undefined){
            console.error("Source report is undefined")
            return
        }
        const pickleJson = this.helper.getJsonFromArray(report, "pickle")
        const testStepFinishedJson = this.helper.getJsonFromArray(report, "testStepFinished")
        const pickleStepId = this.getPickleStepIdByStepId(pickleJson, stepId, ignoreAmount)
        const result = this.getTestStepFinishedResult(testStepFinishedJson, pickleStepId)
        return result
    }

    matchStepDefinitions(stepId, report, ignoreAmount){
        if (typeof report === undefined){
            console.error("Source report is undefined")
            return
        }
        const pickleJson = this.helper.getJsonFromArray(report, "pickle")
        const testCaseJson = this.helper.getJsonFromArray(report, "testCase")
        const stepDefinitionJson = this.helper.getJsonFromArray(report, "stepDefinition")
        const pickleStepId = this.getPickleStepIdByStepId(pickleJson, stepId, ignoreAmount)
        const stepDefinitionId = this.getStepDefinitionId(testCaseJson, pickleStepId)
        const match = this.getMatchedStepDefinition(stepDefinitionJson, stepDefinitionId)
        return match
    }


    getPickleStepIdByStepId(pickleJson, stepId, ignoreAmount){
        let pickleStepId = ""
        let parsed: any
        pickleJson.forEach(element => {
            if (JSON.stringify(element).includes(stepId)){
                ignoreAmount--
                if(ignoreAmount != -1)
                    return
                try {
                    parsed = JSON.parse(element)
                } catch (err) {
                    console.error("Error parsing JSON string:", err)
                }
                const pickleSteps = parsed.pickle.steps
                pickleSteps.forEach(step => {
                    if (step.astNodeIds[0] === stepId){
                        pickleStepId = step.id
                    }
                })
            }
        })
        return pickleStepId
    }

    getTestStepFinishedResult(testStepFinishedJson, pickleStepId){
        let status = ""
        let error_message = null
        let duration = 0
        let parsed: any
        testStepFinishedJson.forEach(stepFinished => {
            if (JSON.stringify(stepFinished).includes(pickleStepId)){
                try {
                    parsed = JSON.parse(stepFinished)
                } catch (err) {
                    console.error("Error parsing JSON string:", err)
                }
                duration = parsed.testStepFinished.testStepResult.duration
                if (typeof duration !== "undefined"){
                    duration = this.convertTotalRunDurationToNanos(duration)
                }
                status = parsed.testStepFinished.testStepResult.status
                error_message = parsed.testStepFinished.testStepResult.message
            }
        })

        return {
            status: status.toLowerCase(),
            duration: duration,
            error_message: error_message
        }
    }

    convertTotalRunDurationToNanos(duration){
        const testStepFinishedSec = duration.seconds
        const testStepFinishedNanos = duration.nanos
        const durationNanos = testStepFinishedSec * 1000000000
        const totalDuration = durationNanos + testStepFinishedNanos
        return totalDuration
    }

    getStepDefinitionId(testCaseJson, pickleStepId){
        let stepDefinitionId = ""
        let parsed: any
        testCaseJson.forEach(testCase => {
            if (JSON.stringify(testCase).includes(pickleStepId)){
                try {
                    parsed = JSON.parse(testCase)
                } catch (err) {
                    console.error("Error parsing JSON string:", err)
                }
                const testSteps = parsed.testCase.testSteps

                testSteps.forEach(test => {
                    if (test.pickleStepId === pickleStepId) {
                        stepDefinitionId = test.stepDefinitionIds[0]
                    }
                })
            }
        })
        return stepDefinitionId
    }

    getMatchedStepDefinition(stepDefinitionJson, stepDefinitionId){
        let uri = ""
        let line = 0
        let parsed: any
        stepDefinitionJson.forEach(stepDef => {
            if (JSON.stringify(stepDef).includes(stepDefinitionId)){
                try {
                    parsed = JSON.parse(stepDef)
                } catch (err) {
                    console.error("Error parsing JSON string:", err)
                }
                uri =  parsed.stepDefinition.sourceReference.uri
                line = parsed.stepDefinition.sourceReference.location.line
            }
        })
        return {
            location: `${uri}:${line}`
        }
    }

    getStepAttachments(stepId, report, ignoreAmount){
        if (typeof report === undefined){
            console.error("Source report is undefined")
            return
        }

        const pickleJson = this.helper.getJsonFromArray(report, "pickle")
        const attachmentsJson = this.helper.getJsonFromArray(report, "attachment")
        const pickleStepId = this.getPickleStepIdByStepId(pickleJson, stepId, ignoreAmount)
        const attachments = this.getAttachments(attachmentsJson, pickleStepId)
        return attachments
    }
    getAttachments(attachmentsJson, pickleStepId){
        let parsedJson: any
        const attachments: Array<object> = []
        attachmentsJson.forEach(attachment => {
            if (JSON.stringify(attachment).includes(pickleStepId)){
                try {
                    parsedJson = JSON.parse(attachment)
                } catch (err) {
                    console.error("Error parsing JSON string:", err)
                }
                const newAttachment = {
                    data: parsedJson.attachment.body,
                    mime_type: parsedJson.attachment.mediaType,
                    contentEncoding: parsedJson.attachment.contentEncoding
                }
                attachments.push(newAttachment)
            }
        })
        return attachments
    }

    getTags(tagsJson){
        if (typeof tagsJson === "undefined"){
            return
        }

        const tags: any [] = []
        let tagsParsed: any
        try {
            const tagsString = JSON.stringify(tagsJson)
            tagsParsed = JSON.parse(tagsString)
        } catch (err) {
            console.error("Error parsing JSON string:", err)
        }
        tagsParsed.forEach(tag => {
            const tagJson = {
                name: tag.name
            }
            tags.push(tagJson)
        })
        return tags
    }

    getComments(commentsJson){
        if (typeof commentsJson === "undefined"){
            return
        }

        const comments: any [] = []
        let commentsParsed: any
        try {
            const commentsString = JSON.stringify(commentsJson)
            commentsParsed = JSON.parse(commentsString)
        } catch (err) {
            console.error("Error parsing JSON string:", err)
        }
        commentsParsed.forEach(commentItem => {
            const comment = {
                line: commentItem.location.line,
                value: commentItem.text
            }
            comments.push(comment)
        })
        return comments
    }

    async validateReportSchema(reportJson){
        console.info("Start cucumber report JSON schema validation...")
        const schemaPath = `${__dirname}/model/cucumber_report_schema.json`
        console.info(`JSON schema path: ${schemaPath}`)
        const schema = await this.helper.readFileIntoJson(schemaPath)
        let parsedSchema: any
        try {
            const schemaString = JSON.stringify(schema)
            parsedSchema = JSON.parse(schemaString)
        } catch (err) {
            console.error("Error parsing JSON string:", err)
        }

        const validator = new jsonschema.Validator()
        const result = validator.validate(reportJson, parsedSchema)
        assert.ok(result, `JSON schama validation failed for report: ${reportJson}`)
        console.info("Cucumber report JSON schema validation passed!")
    }
}
