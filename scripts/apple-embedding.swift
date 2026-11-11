import Foundation
import NaturalLanguage

// Uses the already installed macOS word vectors. No download or third-party dependency.
// Mean pooling is intentionally simple; benchmark it rather than claiming sentence-model quality.
guard let model = NLEmbedding.wordEmbedding(for: .english), let line = readLine(),
      let data = line.data(using: .utf8),
      let text = try JSONSerialization.jsonObject(with: data) as? [String: String],
      let input = text["text"] else { exit(2) }
let tokenizer = NLTokenizer(unit: .word)
tokenizer.string = input.lowercased()
var sum = [Double](repeating: 0, count: model.dimension)
var count = 0
var tokens = 0
tokenizer.enumerateTokens(in: tokenizer.string!.startIndex..<tokenizer.string!.endIndex) { range, _ in
    tokens += 1
    if let vector = model.vector(for: String(tokenizer.string![range])) {
        for index in sum.indices { sum[index] += vector[index] }
        count += 1
    }
    return true
}
guard count > 0 else { exit(3) }
let result: [String: Any] = ["vector": sum.map { $0 / Double(count) }, "tokens": tokens, "estimatedCostUsd": 0]
let output = try JSONSerialization.data(withJSONObject: result)
print(String(data: output, encoding: .utf8)!)
